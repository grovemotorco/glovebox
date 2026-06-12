import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import * as schema from '../src/db/schema/index.ts'

describe('worker database foundation', () => {
  it('exports Better Auth core and API-key plugin tables', () => {
    expect(Object.keys(schema).sort()).toEqual([
      'account',
      'apiKey',
      'apiKeyMetadata',
      'apikey',
      'commentThread',
      'deviceCode',
      'documentVersion',
      'jwks',
      'principal',
      'session',
      'suggestion',
      'user',
      'verification',
      'workspace',
      'workspaceDocument',
      'workspaceInvite',
      'workspaceMember',
    ])
  })

  it('includes D1 binding and initial migration for auth tables', async () => {
    const [wrangler, migration] = await Promise.all([
      readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf-8'),
      readFile(new URL('../migrations/0000_living_shockwave.sql', import.meta.url), 'utf-8'),
    ])

    expect(wrangler).toContain('"binding": "DB"')
    expect(wrangler).toContain('"send_email": [{ "name": "EMAIL" }]')
    for (const variable of [
      'AUTH_EMAIL_FROM',
      'AUTH_EMAIL_FROM_NAME',
      'AUTH_EMAIL_MODE',
      'INVITATION_EMAIL_FROM',
      'INVITATION_EMAIL_FROM_NAME',
      'INVITATION_ACCEPT_URL',
    ]) {
      expect(wrangler).toContain(`"${variable}"`)
    }
    for (const table of [
      'user',
      'session',
      'account',
      'verification',
      'jwks',
      'deviceCode',
      'apikey',
    ]) {
      expect(migration).toContain(`CREATE TABLE \`${table}\``)
    }
    expect(migration).toContain('CREATE INDEX `idx_apikey_referenceId`')
  })

  it('includes Glovebox domain tables for principals, workspaces, invites, and key metadata', async () => {
    const migration = await readFile(
      new URL('../migrations/0001_ambiguous_cardiac.sql', import.meta.url),
      'utf-8',
    )

    for (const table of [
      'principal',
      'workspace',
      'workspaceMember',
      'workspaceInvite',
      'apiKeyMetadata',
    ]) {
      expect(migration).toContain(`CREATE TABLE \`${table}\``)
    }
    expect(migration).toContain('PRIMARY KEY(`workspaceId`, `principalId`)')
    expect(migration).toContain('CREATE UNIQUE INDEX `idx_workspaceInvite_tokenHash`')
    expect(migration).toContain('REFERENCES `apikey`(`id`)')
  })

  it('includes collaboration metadata tables for versions, comments, and suggestions', async () => {
    const migration = await readFile(
      new URL('../migrations/0002_collaboration_metadata.sql', import.meta.url),
      'utf-8',
    )

    for (const table of ['workspaceDocument', 'documentVersion', 'commentThread', 'suggestion']) {
      expect(migration).toContain(`CREATE TABLE \`${table}\``)
    }
    expect(migration).toContain('PRIMARY KEY(`workspaceId`, `fileId`, `versionId`)')
    expect(migration).toContain('CREATE INDEX `idx_commentThread_workspace_file`')
    expect(migration).toContain('CREATE INDEX `idx_suggestion_workspace_file`')
  })
})
