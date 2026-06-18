import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadConfig,
  resolveServer,
  resolveServerUrl,
  setDefaultServer,
} from '../../src/lib/config.ts'
import { gloveboxPaths, type GloveboxPaths } from '../../src/lib/paths.ts'
import { DEFAULT_SERVER_URL } from '../../src/lib/url.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempHome(): Promise<GloveboxPaths> {
  const dir = await mkdtemp(join(tmpdir(), 'glovebox-config-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return gloveboxPaths({ GLOVEBOX_HOME: dir })
}

describe('server resolution', () => {
  it('precedence: flag > env > config > built-in default', async () => {
    const paths = await tempHome()

    expect(await resolveServerUrl(undefined, paths, {})).toBe(DEFAULT_SERVER_URL)
    expect((await resolveServer(undefined, paths, {})).source).toBe('default')

    await setDefaultServer(paths, 'https://cfg.example')
    expect(await resolveServerUrl(undefined, paths, {})).toBe('https://cfg.example')
    expect((await resolveServer(undefined, paths, {})).source).toBe('config')

    const env = { GLOVEBOX_SERVER_URL: 'https://env.example' }
    expect((await resolveServer(undefined, paths, env)).serverUrl).toBe('https://env.example')
    expect((await resolveServer(undefined, paths, env)).source).toBe('env')

    expect((await resolveServer('https://flag.example', paths, env)).serverUrl).toBe(
      'https://flag.example',
    )
    expect((await resolveServer('https://flag.example', paths, env)).source).toBe('flag')
  })

  it('normalizes the persisted default (adds scheme, strips trailing slash)', async () => {
    const paths = await tempHome()
    await setDefaultServer(paths, 'cfg.example/')
    expect((await loadConfig(paths)).defaultServer).toBe('https://cfg.example')
  })

  it('degrades a corrupt config to no preferences', async () => {
    const paths = await tempHome()
    await writeFile(paths.configFile, 'not json{', 'utf-8')
    expect(await loadConfig(paths)).toEqual({ version: 1 })
    expect(await resolveServerUrl(undefined, paths, {})).toBe(DEFAULT_SERVER_URL)
  })
})
