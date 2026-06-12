import { describe, expect, it } from 'vitest'
import {
  humanPrincipalId,
  personalWorkspaceBootstrapRows,
  personalWorkspaceId,
  personalWorkspaceSlug,
} from '../src/lib/workspace-bootstrap.ts'

describe('personal workspace bootstrap', () => {
  it('builds first-signup principal, workspace, and owner membership rows', () => {
    const rows = personalWorkspaceBootstrapRows(
      { id: 'user_123', name: 'Ada Lovelace', email: 'ada@example.com' },
      Date.UTC(2026, 5, 10, 12),
    )

    expect(rows.principal).toMatchObject({
      id: 'human_user_123',
      type: 'human',
      userId: 'user_123',
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
    })
    expect(rows.workspace).toMatchObject({
      id: 'ws_user_123',
      name: "Ada Lovelace's Workspace",
      slug: 'ada-lovelace-user_123',
      authEpoch: 0,
      createdByPrincipalId: 'human_user_123',
    })
    expect(rows.member).toMatchObject({
      workspaceId: 'ws_user_123',
      principalId: 'human_user_123',
      role: 'editor',
      owner: true,
    })
    expect(rows.workspace.createdAt).toEqual(new Date(Date.UTC(2026, 5, 10, 12)))
  })

  it('falls back to email local-part when the display name is blank', () => {
    const rows = personalWorkspaceBootstrapRows(
      { id: 'user:weird', name: ' ', email: 'writer@example.com' },
      0,
    )

    expect(rows.principal.displayName).toBe('writer')
    expect(rows.principal.id).toBe('human_user_weird')
    expect(rows.workspace.id).toBe('ws_user_weird')
  })

  it('sanitizes personal workspace slugs with a stable user suffix', () => {
    expect(personalWorkspaceSlug(' Agent Notes <> ', 'user:abc/123')).toBe(
      'agent-notes-user_abc_123',
    )
    expect(humanPrincipalId('user:abc/123')).toBe('human_user_abc_123')
    expect(personalWorkspaceId('user:abc/123')).toBe('ws_user_abc_123')
  })
})
