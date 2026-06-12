import { describe, expect, it } from 'vitest'
import { signWorkspaceToken, verifyWorkspaceToken } from '../../src/server/auth.ts'

const NOW = 1_750_000_000_000
const CLAIMS = {
  workspaceId: 'ws-1',
  principalId: 'user-7',
  principalType: 'human' as const,
  role: 'editor' as const,
  owner: false,
  epoch: 2,
  exp: NOW + 60_000,
}

describe('workspace tokens', () => {
  it('round-trips authentic unexpired tokens', async () => {
    const token = await signWorkspaceToken(CLAIMS, 'secret-a')
    expect(await verifyWorkspaceToken(token, 'secret-a', NOW)).toEqual(CLAIMS)
  })

  it('rejects a token signed with a different secret', async () => {
    const token = await signWorkspaceToken(CLAIMS, 'secret-a')
    expect(await verifyWorkspaceToken(token, 'secret-b', NOW)).toBeNull()
  })

  it('rejects a tampered payload', async () => {
    const token = await signWorkspaceToken(CLAIMS, 'secret-a')
    const [, signature] = token.split('.')
    const forged = JSON.stringify({ ...CLAIMS, principalId: 'attacker' })
    const forgedPayload = Buffer.from(forged)
      .toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '')
    expect(await verifyWorkspaceToken(`${forgedPayload}.${signature}`, 'secret-a', NOW)).toBeNull()
  })

  it('rejects expired tokens', async () => {
    const token = await signWorkspaceToken({ ...CLAIMS, exp: NOW - 1 }, 'secret-a')
    expect(await verifyWorkspaceToken(token, 'secret-a', NOW)).toBeNull()
  })

  it('rejects malformed tokens without throwing', async () => {
    for (const garbage of ['', 'no-dot', '.', 'a.', '.b', 'ä.ö', 'aGk.aGk']) {
      expect(await verifyWorkspaceToken(garbage, 'secret-a', NOW)).toBeNull()
    }
  })
})
