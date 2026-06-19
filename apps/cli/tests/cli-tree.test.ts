import { describe, expect, it } from 'vitest'
// Type-only import — erased at runtime, so it does NOT execute index.ts's `main()`.
import type { RootCommand } from '../src/cli/index.ts'
import { buildCommandTree } from '../src/cli/help.ts'

describe('buildCommandTree', () => {
  const noop = async (): Promise<void> => {}
  const commands: RootCommand[] = [
    { name: 'auth', group: 'Setup', summary: 'manage credentials', run: noop },
    { name: 'ws', group: 'Setup', summary: 'alias', hidden: true, run: noop },
    { name: 'pull', group: 'Files', summary: 'fetch a file', run: noop },
  ]

  it('emits a machine-readable tree, excluding hidden commands', () => {
    const tree = buildCommandTree(commands)
    expect(tree.name).toBe('glovebox')
    expect(tree.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(tree.defaultServer).toMatch(/^https?:\/\//)
    expect(tree.commands).toEqual([
      { name: 'auth', group: 'Setup', summary: 'manage credentials' },
      { name: 'pull', group: 'Files', summary: 'fetch a file' },
    ])
  })

  it('includes getting-started next actions', () => {
    const tree = buildCommandTree(commands)
    expect(tree.nextActions.length).toBeGreaterThan(0)
    expect(tree.nextActions.some((action) => action.command.includes('auth device'))).toBe(true)
  })
})
