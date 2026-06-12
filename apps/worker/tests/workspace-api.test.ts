import { createGloveboxClient, type GloveboxClient, type RecoveryRecord } from '@glovebox/api'
import { sha256Hex } from '@glovebox/sync'
import { describe, expect, it } from 'vitest'
import { worker } from '../src/dispatcher.ts'
import { humanPrincipalId } from '../src/lib/workspace-bootstrap.ts'
import type { AuthEmailMessage } from '../src/lib/auth-email.ts'
import { TestD1Database } from './d1-test.ts'

type WorkerEnv = Parameters<NonNullable<typeof worker.fetch>>[1]
type WorkerExecutionContext = Parameters<NonNullable<typeof worker.fetch>>[2]

describe('workspace API', () => {
  it('lists the personal workspace and supports workspace CRUD for the owner', async () => {
    const harness = createWorkerHarness()
    const ownerSession = await harness.signUp('owner@example.com', 'Owner User')
    const client = harness.client(ownerSession.cookie)

    const initial = await client.workspaces.list()

    expect(initial.workspaces).toHaveLength(1)
    expect(initial.workspaces[0]).toMatchObject({
      name: "Owner User's Workspace",
      currentPrincipalRole: 'editor',
      currentPrincipalOwner: true,
    })

    const created = await client.workspaces.create({
      name: 'Product Docs',
      slug: 'product-docs',
    })

    expect(created).toMatchObject({
      name: 'Product Docs',
      slug: 'product-docs',
      currentPrincipalRole: 'editor',
      currentPrincipalOwner: true,
      deleted: false,
      authEpoch: 0,
    })

    await expect(client.workspaces.get({ workspaceId: created.id })).resolves.toMatchObject({
      id: created.id,
      name: 'Product Docs',
    })

    const updated = await client.workspaces.update({
      workspaceId: created.id,
      name: 'Product Handbook',
    })

    expect(updated).toMatchObject({
      id: created.id,
      name: 'Product Handbook',
      slug: 'product-docs',
    })

    await expect(client.workspaces.delete({ workspaceId: created.id })).resolves.toEqual({
      ok: true,
    })
    await expect(client.workspaces.get({ workspaceId: created.id })).rejects.toMatchObject({
      code: 'WORKSPACE_DELETED',
    })

    const afterDelete = await client.workspaces.list()
    expect(afterDelete.workspaces.map((workspace) => workspace.id)).not.toContain(created.id)
    expect(harness.doRequests).toContainEqual({
      method: 'POST',
      pathname: `/admin/workspaces/${encodeURIComponent(created.id)}/deleted`,
      body: null,
    })

    harness.close()
  })

  it('hides non-member workspaces and requires owner access for update/delete', async () => {
    const harness = createWorkerHarness()
    const ownerSession = await harness.signUp('owner@example.com', 'Owner User')
    const memberSession = await harness.signUp('member@example.com', 'Member User')
    const owner = harness.client(ownerSession.cookie)
    const member = harness.client(memberSession.cookie)
    const workspace = await owner.workspaces.create({ name: 'Shared Docs' })

    await expect(member.workspaces.get({ workspaceId: workspace.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })

    harness.insertWorkspaceMember({
      workspaceId: workspace.id,
      principalId: humanPrincipalId(memberSession.userId),
      role: 'viewer',
      owner: false,
    })

    await expect(member.workspaces.get({ workspaceId: workspace.id })).resolves.toMatchObject({
      id: workspace.id,
      currentPrincipalRole: 'viewer',
      currentPrincipalOwner: false,
    })
    await expect(
      member.workspaces.update({ workspaceId: workspace.id, name: 'Nope' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(member.workspaces.delete({ workspaceId: workspace.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })

    harness.close()
  })

  it('creates, resends, accepts, cancels invites and manages members', async () => {
    const harness = createWorkerHarness()
    const ownerSession = await harness.signUp('owner@example.com', 'Owner User')
    const memberSession = await harness.signUp('member@example.com', 'Member User')
    const owner = harness.client(ownerSession.cookie)
    const member = harness.client(memberSession.cookie)
    const workspace = await owner.workspaces.create({ name: 'Invite Docs' })

    const invite = await owner.invites.create({
      workspaceId: workspace.id,
      email: 'member@example.com',
      role: 'viewer',
      owner: false,
    })

    expect(invite).toMatchObject({
      workspaceId: workspace.id,
      email: 'member@example.com',
      role: 'viewer',
      owner: false,
      status: 'pending',
    })
    expect(harness.emails.at(-1)).toMatchObject({
      to: 'member@example.com',
      subject: 'Join Invite Docs on Glovebox',
    })
    await expect(owner.invites.list({ workspaceId: workspace.id })).resolves.toMatchObject({
      invites: [expect.objectContaining({ id: invite.id, status: 'pending' })],
    })
    await expect(
      owner.invites.resend({ workspaceId: workspace.id, inviteId: invite.id }),
    ).resolves.toMatchObject({ ok: true })

    const inviteToken = inviteTokenFromEmail(harness.emails.at(-1))
    await expect(member.invites.accept({ inviteToken })).resolves.toMatchObject({
      id: invite.id,
      status: 'accepted',
      acceptedAt: expect.any(Number),
    })

    const members = await owner.members.list({ workspaceId: workspace.id })
    expect(members.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          principal: expect.objectContaining({ id: humanPrincipalId(ownerSession.userId) }),
          role: 'editor',
          owner: true,
        }),
        expect.objectContaining({
          principal: expect.objectContaining({ id: humanPrincipalId(memberSession.userId) }),
          role: 'viewer',
          owner: false,
        }),
      ]),
    )

    const memberPrincipalId = humanPrincipalId(memberSession.userId)
    await expect(
      owner.members.setDocumentRole({
        workspaceId: workspace.id,
        principalId: memberPrincipalId,
        role: 'commenter',
      }),
    ).resolves.toMatchObject({ role: 'commenter', owner: false })
    await expect(
      owner.members.setOwner({
        workspaceId: workspace.id,
        principalId: memberPrincipalId,
        owner: true,
      }),
    ).resolves.toMatchObject({ role: 'commenter', owner: true })
    await expect(
      owner.members.remove({ workspaceId: workspace.id, principalId: memberPrincipalId }),
    ).resolves.toMatchObject({ ok: true, authEpoch: expect.any(Number) })

    const cancelInvite = await owner.members.invite({
      workspaceId: workspace.id,
      email: 'second@example.com',
      role: 'viewer',
      owner: false,
    })
    await expect(
      owner.invites.cancel({ workspaceId: workspace.id, inviteId: cancelInvite.inviteId }),
    ).resolves.toMatchObject({ ok: true, authEpoch: expect.any(Number) })
    await expect(
      member.invites.accept({ inviteToken: inviteTokenFromEmail(harness.emails.at(-1)) }),
    ).rejects.toMatchObject({ code: 'INVITE_NOT_FOUND' })
    expect(recheckBodies(harness, workspace.id)).toEqual(
      expect.arrayContaining([
        { principalIds: [memberPrincipalId] },
        { principalIds: [memberPrincipalId] },
        { principalIds: [memberPrincipalId] },
        { principalIds: [memberPrincipalId] },
        { principalIds: [] },
      ]),
    )

    harness.close()
  })

  it('creates, lists, and deletes API keys with Glovebox metadata', async () => {
    const harness = createWorkerHarness()
    const ownerSession = await harness.signUp('owner@example.com', 'Owner User')
    const owner = harness.client(ownerSession.cookie)
    const workspace = await owner.workspaces.create({ name: 'Key Docs' })

    const created = await owner.keys.create({
      name: 'CLI key',
      purpose: 'cli',
      scopes: ['workspace:read'],
      workspaceIds: [workspace.id],
    })

    expect(created.plaintext).toMatch(/^gbx_/)
    expect(created.key).toMatchObject({
      id: expect.any(String),
      name: 'CLI key',
      prefix: 'gbx_',
      purpose: 'cli',
      scopes: ['workspace:read'],
      workspaceIds: [workspace.id],
      lastUsedAt: null,
      expiresAt: null,
    })

    await expect(owner.keys.list()).resolves.toMatchObject({
      keys: [expect.objectContaining({ id: created.key.id, purpose: 'cli' })],
    })
    await expect(owner.keys.delete({ keyId: created.key.id })).resolves.toMatchObject({
      ok: true,
      authEpoch: expect.any(Number),
    })
    expect(recheckBodies(harness, workspace.id)).toContainEqual({
      principalIds: [humanPrincipalId(ownerSession.userId)],
    })
    await expect(owner.keys.list()).resolves.toEqual({ keys: [] })

    harness.close()
  })

  it('creates, lists, and deletes scoped API keys for workspace owners', async () => {
    const harness = createWorkerHarness()
    const ownerSession = await harness.signUp('owner@example.com', 'Owner User')
    const memberSession = await harness.signUp('member@example.com', 'Member User')
    const owner = harness.client(ownerSession.cookie)
    const member = harness.client(memberSession.cookie)
    const workspace = await owner.workspaces.create({ name: 'Key Docs' })

    await expect(
      member.keys.create({
        name: 'member key',
        purpose: 'api',
        scopes: ['workspace:read'],
        workspaceIds: [workspace.id],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const created = await owner.keys.create({
      name: 'owner key',
      purpose: 'cli',
      scopes: ['workspace:read', 'workspace:write'],
      workspaceIds: [workspace.id],
    })

    expect(created.plaintext).toMatch(/^gbx_/)
    expect(created.key).toMatchObject({
      name: 'owner key',
      prefix: 'gbx_',
      purpose: 'cli',
      scopes: ['workspace:read', 'workspace:write'],
      workspaceIds: [workspace.id],
      lastUsedAt: null,
    })

    await expect(owner.keys.list()).resolves.toMatchObject({
      keys: [expect.objectContaining({ id: created.key.id, name: 'owner key' })],
    })
    await expect(owner.keys.delete({ keyId: created.key.id })).resolves.toMatchObject({
      ok: true,
      authEpoch: expect.any(Number),
    })
    expect(recheckBodies(harness, workspace.id)).toContainEqual({
      principalIds: [humanPrincipalId(ownerSession.userId)],
    })
    await expect(owner.keys.list()).resolves.toEqual({ keys: [] })
    await expect(owner.keys.delete({ keyId: created.key.id })).rejects.toMatchObject({
      code: 'KEY_NOT_FOUND',
    })

    harness.close()
  })

  it('enforces API key workspace scope on workspace APIs', async () => {
    const harness = createWorkerHarness()
    const ownerSession = await harness.signUp('owner@example.com', 'Owner User')
    const owner = harness.client(ownerSession.cookie)
    const allowed = await owner.workspaces.create({ name: 'Allowed Docs' })
    const denied = await owner.workspaces.create({ name: 'Denied Docs' })

    const created = await owner.keys.create({
      name: 'read scoped key',
      purpose: 'api',
      scopes: ['workspace:read'],
      workspaceIds: [allowed.id],
    })
    const apiClient = harness.bearerClient(created.plaintext)

    await expect(apiClient.workspaces.list()).resolves.toMatchObject({
      workspaces: [expect.objectContaining({ id: allowed.id })],
    })
    await expect(apiClient.workspaces.get({ workspaceId: allowed.id })).resolves.toMatchObject({
      id: allowed.id,
    })
    await expect(
      apiClient.auth.mintWorkspaceSocketToken({ workspaceId: allowed.id }),
    ).resolves.toMatchObject({
      claims: expect.objectContaining({ workspaceId: allowed.id }),
    })

    await expect(apiClient.workspaces.get({ workspaceId: denied.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(
      apiClient.workspaces.update({ workspaceId: allowed.id, name: 'Renamed' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(apiClient.members.list({ workspaceId: allowed.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })

    harness.close()
  })

  it('exchanges approved device authorization for a stored Glovebox API key', async () => {
    const harness = createWorkerHarness()
    const ownerSession = await harness.signUp('owner@example.com', 'Owner User')
    const browser = harness.client(ownerSession.cookie)
    const cli = harness.publicClient()
    const personalWorkspace = (await browser.workspaces.list()).workspaces[0]
    if (!personalWorkspace) {
      throw new Error('sign-up did not create a personal workspace')
    }

    const started = await cli.auth.deviceStart({
      purpose: 'cli',
      scopes: ['workspace:read'],
      workspaceIds: [personalWorkspace.id],
    })

    expect(started).toMatchObject({
      deviceCode: expect.any(String),
      userCode: expect.any(String),
      verificationUri: 'https://api.glovebox.test/device',
      verificationUriComplete: expect.stringContaining(encodeURIComponent(started.userCode)),
      intervalSec: expect.any(Number),
    })
    await expect(cli.auth.devicePoll({ deviceCode: started.deviceCode })).resolves.toEqual({
      status: 'pending',
    })

    await expect(browser.auth.deviceApprove({ userCode: started.userCode })).resolves.toEqual({
      ok: true,
    })
    await sleep(started.intervalSec * 1000 + 100)

    const approved = await cli.auth.devicePoll({ deviceCode: started.deviceCode })
    expect(approved).toMatchObject({
      status: 'approved',
      apiKey: expect.stringMatching(/^gbx_/),
    })
    const apiKey = approved.apiKey
    if (!apiKey) {
      throw new Error('device flow did not return an api key')
    }

    const apiClient = harness.bearerClient(apiKey)
    await expect(apiClient.keys.list()).resolves.toMatchObject({
      keys: [
        expect.objectContaining({
          purpose: 'cli',
          scopes: ['workspace:read'],
          workspaceIds: [personalWorkspace.id],
        }),
      ],
    })
    await expect(apiClient.workspaces.list()).resolves.toMatchObject({
      workspaces: [expect.objectContaining({ name: "Owner User's Workspace" })],
    })

    harness.close()
  }, 10_000)

  it('serves document versions and enforces comment/suggestion roles', async () => {
    const harness = createWorkerHarness()
    const ownerSession = await harness.signUp('owner@example.com', 'Owner User')
    const commenterSession = await harness.signUp('commenter@example.com', 'Commenter User')
    const viewerSession = await harness.signUp('viewer@example.com', 'Viewer User')
    const owner = harness.client(ownerSession.cookie)
    const commenter = harness.client(commenterSession.cookie)
    const viewer = harness.client(viewerSession.cookie)
    const workspace = await owner.workspaces.create({ name: 'Collab Docs' })
    const fileId = 'file-collab'
    const versionId = 'ver-seed'

    harness.insertWorkspaceMember({
      workspaceId: workspace.id,
      principalId: humanPrincipalId(commenterSession.userId),
      role: 'commenter',
      owner: false,
    })
    harness.insertWorkspaceMember({
      workspaceId: workspace.id,
      principalId: humanPrincipalId(viewerSession.userId),
      role: 'viewer',
      owner: false,
    })
    harness.insertDocumentVersion({
      workspaceId: workspace.id,
      fileId,
      path: 'docs/collab.md',
      versionId,
      text: 'hello collab\n',
      createdByPrincipalId: humanPrincipalId(ownerSession.userId),
    })

    await expect(
      owner.documents.metadata({ workspaceId: workspace.id, fileId }),
    ).resolves.toMatchObject({
      workspaceId: workspace.id,
      fileId,
      path: 'docs/collab.md',
      currentVersionId: versionId,
    })
    await expect(
      viewer.documents.readText({ workspaceId: workspace.id, fileId }),
    ).resolves.toMatchObject({
      text: 'hello collab\n',
      version: expect.objectContaining({ versionId }),
    })
    await expect(
      owner.versions.compare({
        workspaceId: workspace.id,
        fileId,
        baseVersionId: versionId,
        targetVersionId: versionId,
      }),
    ).resolves.toMatchObject({ changed: false })

    await expect(
      viewer.comments.create({
        workspaceId: workspace.id,
        fileId,
        baseVersionId: versionId,
        range: { start: 0, end: 5 },
        body: 'viewer cannot comment',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const comment = await commenter.comments.create({
      workspaceId: workspace.id,
      fileId,
      baseVersionId: versionId,
      range: { start: 0, end: 5 },
      body: 'tighten this opening',
    })
    expect(comment).toMatchObject({
      status: 'open',
      authorPrincipalId: humanPrincipalId(commenterSession.userId),
    })
    await expect(
      commenter.comments.resolve({ workspaceId: workspace.id, threadId: comment.id }),
    ).resolves.toMatchObject({ status: 'resolved', resolvedAt: expect.any(Number) })

    const suggestion = await commenter.suggestions.propose({
      workspaceId: workspace.id,
      fileId,
      baseVersionId: versionId,
      range: { start: 0, end: 5 },
      replacementText: 'Hello',
    })
    expect(suggestion).toMatchObject({ status: 'open', replacementText: 'Hello' })
    await expect(
      commenter.suggestions.accept({ workspaceId: workspace.id, suggestionId: suggestion.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      owner.suggestions.accept({ workspaceId: workspace.id, suggestionId: suggestion.id }),
    ).resolves.toMatchObject({
      status: 'accepted',
      decidedBy: humanPrincipalId(ownerSession.userId),
    })
    await expect(
      viewer.documents.readText({ workspaceId: workspace.id, fileId }),
    ).resolves.toMatchObject({
      text: 'Hello collab\n',
      version: expect.objectContaining({ seq: 2, label: `suggestion:${suggestion.id}` }),
    })
    const acceptedVersion = await owner.documents.currentVersion({
      workspaceId: workspace.id,
      fileId,
    })
    await expect(
      commenter.suggestions.list({ workspaceId: workspace.id, fileId }),
    ).resolves.toMatchObject({
      suggestions: [expect.objectContaining({ id: suggestion.id, status: 'accepted' })],
    })

    await expect(
      owner.workspaces.textPush({
        workspaceId: workspace.id,
        fileId,
        newText: 'Manual edit\n',
        baseHashHex: sha256Hex('Hello collab\n'),
        idempotencyKey: 'manual-edit',
      }),
    ).resolves.toMatchObject({ status: 'applied', fileId, versionId: expect.any(String) })
    void acceptedVersion

    const staleSuggestion = await commenter.suggestions.propose({
      workspaceId: workspace.id,
      fileId,
      baseVersionId: versionId,
      range: { start: 0, end: 5 },
      replacementText: 'Stale',
    })
    await expect(
      owner.suggestions.accept({ workspaceId: workspace.id, suggestionId: staleSuggestion.id }),
    ).rejects.toMatchObject({ code: 'STALE_VERSION' })
    await expect(
      commenter.suggestions.list({ workspaceId: workspace.id, fileId }),
    ).resolves.toMatchObject({
      suggestions: expect.arrayContaining([
        expect.objectContaining({
          id: staleSuggestion.id,
          status: 'open',
          range: expect.objectContaining({ stale: true }),
        }),
      ]),
    })

    harness.close()
  })

  it('mints and verifies workspace socket tokens for members', async () => {
    const harness = createWorkerHarness()
    const ownerSession = await harness.signUp('owner@example.com', 'Owner User')
    const owner = harness.client(ownerSession.cookie)
    const workspace = await owner.workspaces.create({ name: 'Socket Docs' })

    const minted = await owner.auth.mintWorkspaceSocketToken({ workspaceId: workspace.id })
    // The harness configures WS_AUTH_SECRET — a null token means it didn't.
    if (minted.token === null) throw new Error('expected socket auth to be configured in harness')

    expect(minted.claims).toMatchObject({
      workspaceId: workspace.id,
      principalId: humanPrincipalId(ownerSession.userId),
      principalType: 'human',
      role: 'editor',
      owner: true,
      epoch: 0,
    })
    expect(minted.token).toContain('.')
    await expect(
      owner.auth.verifyWorkspaceSocketToken({
        workspaceId: workspace.id,
        tokenPayloadB64: btoa(minted.token),
      }),
    ).resolves.toEqual({ valid: true })
    await expect(
      owner.auth.verifyWorkspaceSocketToken({
        workspaceId: 'other-workspace',
        tokenPayloadB64: btoa(minted.token),
      }),
    ).resolves.toEqual({ valid: false })

    const wsResponse = await dispatch(
      new Request(
        `https://api.glovebox.test/ws/${encodeURIComponent(workspace.id)}?token=${encodeURIComponent(minted.token)}`,
        { headers: { Upgrade: 'websocket' } },
      ),
      harness.env,
    )

    expect(wsResponse.status).toBe(200)

    harness.close()
  })

  it('serves and dismisses workspace recovery records over the DO bridge', async () => {
    const harness = createWorkerHarness()
    const ownerSession = await harness.signUp('recovery-owner@example.com', 'Owner User')
    const viewerSession = await harness.signUp('recovery-viewer@example.com', 'Viewer User')
    const outsiderSession = await harness.signUp('recovery-outsider@example.com', 'Outsider')
    const owner = harness.client(ownerSession.cookie)
    const viewer = harness.client(viewerSession.cookie)
    const outsider = harness.client(outsiderSession.cookie)
    const workspace = await owner.workspaces.create({ name: 'Recovery Docs' })
    harness.insertWorkspaceMember({
      workspaceId: workspace.id,
      principalId: humanPrincipalId(viewerSession.userId),
      role: 'viewer',
      owner: false,
    })

    harness.doRecoveryRecords.push(
      {
        recordId: 'rec-1',
        fileId: 'file-a',
        opId: 'op-1',
        reason: 'remote-edit-wins',
        deviceId: 'device-1',
        observedPath: 'docs/a.md',
        payload: JSON.stringify({ op: { type: 'file.deleteIntent', fileId: 'file-a' } }),
        createdAt: 1_750_000_000_000,
        acknowledgedAt: null,
      },
      {
        recordId: 'rec-2',
        fileId: 'file-b',
        opId: 'op-2',
        reason: 'rename-target-occupied',
        deviceId: 'device-2',
        observedPath: 'docs/b.md',
        payload: JSON.stringify({ op: { type: 'file.rename', fileId: 'file-b' } }),
        createdAt: 1_750_000_000_001,
        acknowledgedAt: null,
      },
    )

    // Read access suffices (ISSUE-0041): a viewer can list the trash.
    const listed = await viewer.documents.recoveryList({ workspaceId: workspace.id })
    expect(listed.records.map((record) => record.recordId)).toEqual(['rec-1', 'rec-2'])
    expect(harness.doRequests.at(-1)).toMatchObject({
      pathname: `/admin/workspaces/${workspace.id}/recovery/list`,
      body: { pendingOnly: true },
    })

    // The per-file view filters and reports availability.
    await expect(
      viewer.documents.recovery({ workspaceId: workspace.id, fileId: 'file-a' }),
    ).resolves.toMatchObject({
      fileId: 'file-a',
      available: true,
      records: [expect.objectContaining({ recordId: 'rec-1', reason: 'remote-edit-wins' })],
    })
    await expect(
      viewer.documents.recovery({ workspaceId: workspace.id, fileId: 'file-none' }),
    ).resolves.toMatchObject({ available: false, records: [] })

    // Dismiss removes it from the pending view but not from history.
    await expect(
      viewer.documents.recoveryAcknowledge({ workspaceId: workspace.id, recordId: 'rec-1' }),
    ).resolves.toEqual({ acknowledged: true })
    const pending = await viewer.documents.recoveryList({ workspaceId: workspace.id })
    expect(pending.records.map((record) => record.recordId)).toEqual(['rec-2'])
    const all = await viewer.documents.recoveryList({
      workspaceId: workspace.id,
      includeAcknowledged: true,
    })
    expect(all.records).toHaveLength(2)

    // Acknowledging a missing record is honest about it.
    await expect(
      viewer.documents.recoveryAcknowledge({ workspaceId: workspace.id, recordId: 'rec-1' }),
    ).resolves.toEqual({ acknowledged: false })

    // Non-members never learn the workspace exists.
    await expect(
      outsider.documents.recoveryList({ workspaceId: workspace.id }),
    ).rejects.toMatchObject({ status: 404 })

    harness.close()
  })

  it('serves the D5 text tier from live DO state and ingests A6 metadata', async () => {
    const harness = createWorkerHarness()
    const ownerSession = await harness.signUp('text-owner@example.com', 'Owner User')
    const viewerSession = await harness.signUp('text-viewer@example.com', 'Viewer User')
    const owner = harness.client(ownerSession.cookie)
    const viewer = harness.client(viewerSession.cookie)
    const workspace = await owner.workspaces.create({ name: 'Text Tier' })
    harness.insertWorkspaceMember({
      workspaceId: workspace.id,
      principalId: humanPrincipalId(viewerSession.userId),
      role: 'viewer',
      owner: false,
    })

    // A file that exists ONLY in the DO — no D1 rows at all.
    harness.doTextFiles.set('file-live', 'live text\n')

    // Pull surfaces: tree + readText by fileId and by path.
    await expect(viewer.workspaces.tree({ workspaceId: workspace.id })).resolves.toMatchObject({
      entries: [expect.objectContaining({ fileId: 'file-live', path: 'file-live.md' })],
    })
    const read = await viewer.workspaces.readText({
      workspaceId: workspace.id,
      fileId: 'file-live',
    })
    expect(read).toMatchObject({
      text: 'live text\n',
      hashHex: sha256Hex('live text\n'),
      role: 'viewer',
      document: expect.objectContaining({ fileId: 'file-live', path: 'file-live.md' }),
    })
    // No D1 row yet, so no currentVersionId.
    expect(read.document.currentVersionId).toBeUndefined()
    await expect(
      viewer.workspaces.readText({ workspaceId: workspace.id, path: 'file-live.md' }),
    ).resolves.toMatchObject({ text: 'live text\n' })
    await expect(
      viewer.workspaces.readText({ workspaceId: workspace.id, fileId: 'file-none' }),
    ).rejects.toMatchObject({ status: 404 })

    // Viewers cannot push.
    await expect(
      viewer.workspaces.textPush({
        workspaceId: workspace.id,
        fileId: 'file-live',
        newText: 'nope\n',
        baseHashHex: read.hashHex,
        idempotencyKey: 'viewer-push',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    // Push lands via the DO and ingests the A6 metadata layer: the
    // workspaceDocument row (previously writer-less) plus a version row
    // carrying the DO's REAL content version.
    const pushed = await owner.workspaces.textPush({
      workspaceId: workspace.id,
      fileId: 'file-live',
      newText: 'live text\nagent line\n',
      baseHashHex: read.hashHex,
      idempotencyKey: 'push-1',
    })
    expect(pushed).toMatchObject({
      status: 'applied',
      fileId: 'file-live',
      changed: true,
      failedHunks: [],
      text: 'live text\nagent line\n',
    })
    if (pushed.status !== 'applied') throw new Error('unreachable')
    expect(harness.doRequests.at(-1)).toMatchObject({
      pathname: `/admin/workspaces/${workspace.id}/text/push`,
      body: expect.objectContaining({
        fileId: 'file-live',
        baseHashHex: read.hashHex,
        modifiedBy: humanPrincipalId(ownerSession.userId),
      }),
    })
    await expect(
      owner.documents.metadata({ workspaceId: workspace.id, fileId: 'file-live' }),
    ).resolves.toMatchObject({
      path: 'file-live.md',
      currentVersionId: pushed.versionId,
    })
    await expect(
      owner.documents.readText({ workspaceId: workspace.id, fileId: 'file-live' }),
    ).resolves.toMatchObject({
      text: 'live text\nagent line\n',
      version: expect.objectContaining({
        seq: 1,
        label: 'push:push-1',
        contentVersionB64: pushed.contentVersionB64,
      }),
    })

    // A lost-response retry with the same idempotencyKey returns the same
    // version row instead of minting another.
    const retried = await owner.workspaces.textPush({
      workspaceId: workspace.id,
      fileId: 'file-live',
      newText: 'live text\nagent line\n',
      baseHashHex: read.hashHex,
      idempotencyKey: 'push-1',
    })
    if (retried.status !== 'applied') throw new Error('unreachable')
    expect(retried.versionId).toBe(pushed.versionId)

    // Refusals pass through untouched and write no metadata.
    harness.doTextPushOverride.value = { status: 'degenerate-rewrite', deletedRatio: 0.9 }
    await expect(
      owner.workspaces.textPush({
        workspaceId: workspace.id,
        fileId: 'file-live',
        newText: 'tiny\n',
        baseHashHex: read.hashHex,
        idempotencyKey: 'push-degenerate',
      }),
    ).resolves.toEqual({
      status: 'degenerate-rewrite',
      fileId: 'file-live',
      deletedRatio: 0.9,
    })
    harness.doTextPushOverride.value = { status: 'base-missing' }
    await expect(
      owner.workspaces.textPush({
        workspaceId: workspace.id,
        fileId: 'file-live',
        newText: 'x\n',
        baseHashHex: read.hashHex,
        idempotencyKey: 'push-missing',
      }),
    ).resolves.toEqual({ status: 'base-missing', fileId: 'file-live' })
    const versions = await owner.documents.versions({
      workspaceId: workspace.id,
      fileId: 'file-live',
    })
    expect(versions.versions).toHaveLength(1)

    harness.close()
  })
})

type WorkerHarness = {
  signUp(email: string, name: string): Promise<{ cookie: string; userId: string }>
  publicClient(): GloveboxClient
  client(cookie: string): GloveboxClient
  bearerClient(token: string): GloveboxClient
  insertWorkspaceMember(input: {
    workspaceId: string
    principalId: string
    role: 'viewer' | 'commenter' | 'editor'
    owner: boolean
  }): void
  insertDocumentVersion(input: {
    workspaceId: string
    fileId: string
    path: string
    versionId: string
    text: string
    createdByPrincipalId: string
  }): void
  env: WorkerEnv
  emails: AuthEmailMessage[]
  doRequests: DoRequest[]
  /** Canned WorkspaceDO recovery records served by the DO mock. */
  doRecoveryRecords: RecoveryRecord[]
  /** Live-text state served by the DO mock's text/{tree,read,push} routes. */
  doTextFiles: Map<string, string>
  /** When set, text/push responds with this instead of the echo default. */
  doTextPushOverride: { value: unknown }
  close(): void
}

type DoRequest = {
  method: string
  pathname: string
  body: unknown
}

function createWorkerHarness(): WorkerHarness {
  const d1 = new TestD1Database()
  const emails: AuthEmailMessage[] = []
  const doRequests: DoRequest[] = []
  const doRecoveryRecords: RecoveryRecord[] = []
  const doTextFiles = new Map<string, string>()
  const doTextPushOverride: { value: unknown } = { value: null }
  const env = createEnv(d1, emails, doRequests, doRecoveryRecords, doTextFiles, doTextPushOverride)

  return {
    async signUp(email, name) {
      const response = await dispatch(
        new Request('https://api.glovebox.test/api/auth/sign-up/email', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://api.glovebox.test',
          },
          body: JSON.stringify({
            email,
            name,
            password: 'correct horse battery staple',
          }),
        }),
        env,
      )

      expect(response.status).toBe(200)
      const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
      if (!cookie) {
        throw new Error('sign-up did not set a session cookie')
      }
      const body = await jsonObject(response)
      const user = body.user
      if (!user || typeof user !== 'object' || !('id' in user) || typeof user.id !== 'string') {
        throw new Error('sign-up did not return a user id')
      }
      return { cookie, userId: user.id }
    },
    publicClient() {
      return createGloveboxClient({
        baseUrl: 'https://api.glovebox.test',
        fetch: (request, init) => dispatch(new Request(request, init), env),
      })
    },
    client(cookie) {
      return createGloveboxClient({
        baseUrl: 'https://api.glovebox.test',
        fetch: (request, init) => {
          const headers = new Headers(init?.headers)
          headers.set('cookie', cookie)
          return dispatch(new Request(request, { ...init, headers }), env)
        },
      })
    },
    bearerClient(token) {
      return createGloveboxClient({
        baseUrl: 'https://api.glovebox.test',
        fetch: (request, init) => {
          const headers = new Headers(init?.headers)
          headers.set('authorization', `Bearer ${token}`)
          return dispatch(new Request(request, { ...init, headers }), env)
        },
      })
    },
    insertWorkspaceMember(input) {
      const now = Date.now()
      d1.db
        .prepare(
          `INSERT INTO workspaceMember
            (workspaceId, principalId, role, owner, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.workspaceId, input.principalId, input.role, input.owner ? 1 : 0, now, now)
    },
    insertDocumentVersion(input) {
      const now = Date.now()
      d1.db
        .prepare(
          `INSERT OR REPLACE INTO workspaceDocument
            (workspaceId, fileId, path, contentKind, sizeBytes, currentVersionId, updatedAt)
            VALUES (?, ?, ?, 'markdown', ?, ?, ?)`,
        )
        .run(
          input.workspaceId,
          input.fileId,
          input.path,
          new TextEncoder().encode(input.text).byteLength,
          input.versionId,
          now,
        )
      d1.db
        .prepare(
          `INSERT INTO documentVersion
            (workspaceId, fileId, versionId, seq, contentVersionB64, text, createdByPrincipalId, createdAt, label)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.workspaceId,
          input.fileId,
          input.versionId,
          1,
          btoa(`version:${input.versionId}`),
          input.text,
          input.createdByPrincipalId,
          now,
          'seed',
        )
    },
    env,
    emails,
    doRequests,
    doRecoveryRecords,
    doTextFiles,
    doTextPushOverride,
    close() {
      d1.close()
    },
  }
}

function createEnv(
  d1: TestD1Database,
  emails: AuthEmailMessage[],
  doRequests: DoRequest[],
  doRecoveryRecords: RecoveryRecord[] = [],
  doTextFiles = new Map<string, string>(),
  doTextPushOverride: { value: unknown } = { value: null },
): WorkerEnv {
  const textFileView = (fileId: string, text: string) => ({
    status: 'ok',
    fileId,
    path: `${fileId}.md`,
    text,
    hashHex: sha256Hex(text),
    contentVersionB64: btoa(`vv:${fileId}:${text.length}`),
    sizeBytes: new TextEncoder().encode(text).byteLength,
    seq: 1,
    modifiedBy: 'do-mock',
    modifiedAt: 1_750_000_000_000,
  })
  return {
    DB: d1 as unknown as WorkerEnv['DB'],
    WORKSPACE_DO: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async (request: Request) => {
          const pathname = new URL(request.url).pathname
          const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
          doRequests.push({ method: request.method, pathname, body })
          if (pathname.endsWith('/text/tree')) {
            const entries = [...doTextFiles.entries()].map(([fileId, text]) => ({
              fileId,
              path: `${fileId}.md`,
              contentKind: 'markdown',
              contentHash: sha256Hex(text),
              sizeBytes: new TextEncoder().encode(text).byteLength,
              version: 1,
              seq: 1,
              modifiedBy: 'do-mock',
              modifiedAt: 1_750_000_000_000,
            }))
            return Response.json({ ok: true, entries, currentSeq: entries.length })
          }
          if (pathname.endsWith('/text/read')) {
            const fileId = typeof body?.fileId === 'string' ? body.fileId : ''
            const text = doTextFiles.get(fileId)
            return Response.json({
              ok: true,
              file: text === undefined ? { status: 'not-found' } : textFileView(fileId, text),
            })
          }
          if (pathname.endsWith('/text/push')) {
            if (doTextPushOverride.value !== null) {
              return Response.json({ ok: true, result: doTextPushOverride.value })
            }
            const fileId = typeof body?.fileId === 'string' ? body.fileId : ''
            const newText = typeof body?.newText === 'string' ? body.newText : ''
            const changed = doTextFiles.get(fileId) !== newText
            doTextFiles.set(fileId, newText)
            return Response.json({
              ok: true,
              result: {
                status: 'applied',
                changed,
                failedHunks: [],
                path: `${fileId}.md`,
                text: newText,
                hashHex: sha256Hex(newText),
                contentVersionB64: btoa(`vv:${fileId}:${newText.length}`),
              },
            })
          }
          if (pathname.endsWith('/recovery/list')) {
            const records =
              body?.pendingOnly === true
                ? doRecoveryRecords.filter((record) => record.acknowledgedAt === null)
                : doRecoveryRecords
            return Response.json({ ok: true, records })
          }
          if (pathname.endsWith('/recovery/acknowledge')) {
            const record = doRecoveryRecords.find(
              (candidate) =>
                candidate.recordId === body?.recordId && candidate.acknowledgedAt === null,
            )
            if (record) record.acknowledgedAt = Date.now()
            return Response.json({ ok: true, acknowledged: Boolean(record) })
          }
          return Response.json({ ok: true })
        },
      }),
    },
    AUTH_EMAIL_MODE: 'fake',
    FAKE_AUTH_EMAILS: emails,
    BETTER_AUTH_SECRET: 'test-auth-secret-that-is-long-enough',
    BETTER_AUTH_URL: 'https://api.glovebox.test',
    BETTER_AUTH_TRUSTED_ORIGIN: 'https://api.glovebox.test,https://api.glovebox.test',
    BETTER_AUTH_DEV_PASSWORD: 'true',
    WS_AUTH_SECRET: 'test-workspace-secret',
  } as WorkerEnv
}

function dispatch(request: Request, env: WorkerEnv): Promise<Response> {
  const fetch = worker.fetch
  if (!fetch) {
    throw new Error('worker has no fetch handler')
  }
  return fetch(request, env, createExecutionContext())
}

function createExecutionContext(): WorkerExecutionContext {
  return {
    passThroughOnException() {},
    waitUntil() {},
  }
}

function recheckBodies(harness: WorkerHarness, workspaceId: string): unknown[] {
  const pathname = `/admin/workspaces/${encodeURIComponent(workspaceId)}/recheck`
  return harness.doRequests
    .filter((request) => request.method === 'POST' && request.pathname === pathname)
    .map((request) => request.body)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function jsonObject(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json()
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected JSON object response')
  }
  return value as Record<string, unknown>
}

function inviteTokenFromEmail(message: AuthEmailMessage | undefined): string {
  if (!message) {
    throw new Error('expected invitation email')
  }
  const token = /[?&]token=([A-Za-z0-9_-]+)/.exec(message.text)?.[1]
  if (!token) {
    throw new Error('invitation email did not include token')
  }
  return token
}
