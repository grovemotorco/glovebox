import { describe, it, expect } from 'vitest'
import {
  requireWorkspaceMarkdownPath,
  requireWorkspaceRelativePath,
} from '../../src/fs/workspace-path.ts'

describe('requireWorkspaceRelativePath', () => {
  it('normalizes simple paths', () => {
    expect(requireWorkspaceRelativePath('notes.md')).toBe('notes.md')
    expect(requireWorkspaceRelativePath('dir/file.md')).toBe('dir/file.md')
    expect(requireWorkspaceRelativePath('dir')).toBe('dir')
  })

  it('rejects absolute paths', () => {
    expect(() => requireWorkspaceRelativePath('/etc/passwd')).toThrow('Invalid workspace path')
  })

  it('rejects traversal paths', () => {
    expect(() => requireWorkspaceRelativePath('../escape.md')).toThrow('Invalid workspace path')
    expect(() => requireWorkspaceRelativePath('dir/../escape.md')).toThrow('Invalid workspace path')
  })

  it('rejects empty paths', () => {
    expect(() => requireWorkspaceRelativePath('')).toThrow('Invalid workspace path')
  })
})

describe('requireWorkspaceMarkdownPath', () => {
  it('accepts markdown files only', () => {
    expect(requireWorkspaceMarkdownPath('notes.md')).toBe('notes.md')
    expect(requireWorkspaceMarkdownPath('dir/file.markdown')).toBe('dir/file.markdown')
  })

  it('rejects non-markdown paths', () => {
    expect(() => requireWorkspaceMarkdownPath('.bashrc')).toThrow('Invalid markdown workspace path')
    expect(() => requireWorkspaceMarkdownPath('scripts/install.sh')).toThrow(
      'Invalid markdown workspace path',
    )
    expect(() => requireWorkspaceMarkdownPath('docs')).toThrow('Invalid markdown workspace path')
  })
})
