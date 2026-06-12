import { describe, expect, test } from 'vitest'
import {
  MAX_WORKSPACE_PATH_LENGTH,
  normalizeWorkspaceMarkdownPath,
  normalizeWorkspaceRelativePath,
} from '../src/index.ts'

describe('workspace path normalization', () => {
  test('accepts normal relative paths and normalizes separators', () => {
    expect(normalizeWorkspaceRelativePath('docs/readme.md')).toBe('docs/readme.md')
    expect(normalizeWorkspaceRelativePath('docs\\readme.md')).toBe('docs/readme.md')
    expect(normalizeWorkspaceRelativePath('docs//notes.md')).toBe('docs/notes.md')
    expect(normalizeWorkspaceRelativePath('docs/')).toBe('docs')
  })

  test('rejects empty, absolute, and traversal-like paths', () => {
    expect(normalizeWorkspaceRelativePath('')).toBeNull()
    expect(normalizeWorkspaceRelativePath('/etc/passwd')).toBeNull()
    expect(normalizeWorkspaceRelativePath('../secret.md')).toBeNull()
    expect(normalizeWorkspaceRelativePath('docs/../secret.md')).toBeNull()
    expect(normalizeWorkspaceRelativePath('./notes.md')).toBeNull()
  })

  test('normalizes unicode to NFC and rejects overlong paths', () => {
    expect(normalizeWorkspaceRelativePath('cafe\u0301/notes.md')).toBe('café/notes.md')

    const tooLongSegment = 'a'.repeat(MAX_WORKSPACE_PATH_LENGTH + 1)
    expect(normalizeWorkspaceRelativePath(`${tooLongSegment}.md`)).toBeNull()
  })
})

describe('workspace markdown path normalization', () => {
  test('accepts markdown files only', () => {
    expect(normalizeWorkspaceMarkdownPath('docs/readme.md')).toBe('docs/readme.md')
    expect(normalizeWorkspaceMarkdownPath('docs\\notes.markdown')).toBe('docs/notes.markdown')
    expect(normalizeWorkspaceMarkdownPath('.hidden.md')).toBe('.hidden.md')
  })

  test('rejects directories and non-markdown files', () => {
    expect(normalizeWorkspaceMarkdownPath('docs/')).toBeNull()
    expect(normalizeWorkspaceMarkdownPath('.bashrc')).toBeNull()
    expect(normalizeWorkspaceMarkdownPath('scripts/install.sh')).toBeNull()
  })
})
