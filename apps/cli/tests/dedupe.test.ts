import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Cross-cutting dedupe check (spec §5.4), enforced in CI via `vp test`:
 * a duplicated CRDT library silently breaks sync entirely, and duplicated
 * CodeMirror state/view breaks the editor binding's instanceof checks.
 * The pnpm lockfile is the install-state authority — every bundle
 * (worker, client, daemon, CLI) resolves from it, so a single resolution
 * per package means a single copy per bundle. The M8 gate test asserts
 * the CLI bundle's single inlined WASM on top of this.
 */

const REPO_ROOT = join(import.meta.dirname, '../../..')

/** Distinct resolved versions of `name` in pnpm-lock.yaml. */
async function lockfileVersions(name: string): Promise<string[]> {
  const lock = await readFile(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf-8')
  const versions = new Set<string>()
  // Resolution keys look like:  '@scope/name@1.2.3':  or  name@1.2.3:
  const pattern = new RegExp(`^  '?${name.replace('/', '\\/')}@([^'(:]+)`, 'gm')
  for (const match of lock.matchAll(pattern)) {
    versions.add(match[1]!)
  }
  return [...versions].sort()
}

describe('single-copy invariants (spec §5.4)', () => {
  it('loro-crdt resolves to exactly one version', async () => {
    const versions = await lockfileVersions('loro-crdt')
    expect(versions, `loro-crdt versions: ${versions.join(', ')}`).toHaveLength(1)
  })

  it('@codemirror/state resolves to exactly one version', async () => {
    const versions = await lockfileVersions('@codemirror/state')
    expect(versions, `@codemirror/state versions: ${versions.join(', ')}`).toHaveLength(1)
  })

  it('@codemirror/view resolves to exactly one version', async () => {
    const versions = await lockfileVersions('@codemirror/view')
    expect(versions, `@codemirror/view versions: ${versions.join(', ')}`).toHaveLength(1)
  })

  it('the CLI bundle inlines loro through the single bundler entry', async () => {
    const config = await readFile(join(REPO_ROOT, 'apps/cli/vite.config.ts'), 'utf-8')
    expect(config).toContain(`'loro-crdt': 'loro-crdt/bundler/index.js'`)
    expect(config).toContain(`'.wasm': 'binary'`)
  })
})
