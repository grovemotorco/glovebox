import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { signWorkspaceToken } from '@glovebox/sync/server'
import { gloveboxPaths } from '../../src/lib/paths.ts'
import {
  decodeTokenClaims,
  getToken,
  loadAuth,
  removeToken,
  saveToken,
} from '../../src/lib/auth-store.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
})

async function tempPaths() {
  const home = await mkdtemp(join(tmpdir(), 'glovebox-home-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  return gloveboxPaths({ GLOVEBOX_HOME: home })
}

describe('auth store', () => {
  it('stores one token per normalized server URL at 0600', async () => {
    const paths = await tempPaths()
    await saveToken(paths, 'https://api.glovebox.test/', 'token-a')
    await saveToken(paths, 'https://other.example', 'token-b')

    // Trailing slash normalizes away; lookup matches either spelling.
    expect(await getToken(paths, 'https://api.glovebox.test')).toBe('token-a')
    expect(await getToken(paths, 'https://other.example/')).toBe('token-b')
    expect(await getToken(paths, 'https://unknown.example')).toBeNull()

    const mode = (await stat(paths.authFile)).mode & 0o777
    expect(mode).toBe(0o600)

    expect(await removeToken(paths, 'https://other.example')).toBe(true)
    expect(await removeToken(paths, 'https://other.example')).toBe(false)
    expect(Object.keys((await loadAuth(paths)).servers)).toEqual(['https://api.glovebox.test'])
  })

  it('decodes real token claims for display (no verification implied)', async () => {
    const claims = {
      workspaceId: 'ws-1',
      principalId: 'dev-user',
      principalType: 'human' as const,
      role: 'editor' as const,
      owner: false,
      epoch: 3,
      exp: 1_900_000_000_000,
    }
    const token = await signWorkspaceToken(claims, 'secret')
    expect(decodeTokenClaims(token)).toEqual(claims)
    expect(decodeTokenClaims('garbage')).toBeNull()
    expect(decodeTokenClaims('still.garbage')).toBeNull()
  })
})
