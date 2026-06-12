import { describe, it, expect } from 'vitest'
import { isMarkdownFile, isSyncableFile } from '../../src/fs/file-kind.ts'

describe('isMarkdownFile', () => {
  it('matches .md files', () => {
    expect(isMarkdownFile('readme.md')).toBe(true)
    expect(isMarkdownFile('NOTES.MD')).toBe(true)
  })

  it('matches .markdown files', () => {
    expect(isMarkdownFile('doc.markdown')).toBe(true)
    expect(isMarkdownFile('DOC.MARKDOWN')).toBe(true)
  })

  it('rejects non-markdown files', () => {
    expect(isMarkdownFile('file.txt')).toBe(false)
    expect(isMarkdownFile('file.js')).toBe(false)
    expect(isMarkdownFile('file.mdx')).toBe(false)
    expect(isMarkdownFile('.md')).toBe(true) // technically has .md extension
  })
})

describe('isSyncableFile', () => {
  it('ignores local metadata and non-markdown files by basename', () => {
    expect(isSyncableFile('.DS_Store')).toBe(false)
    expect(isSyncableFile('notes/.DS_Store')).toBe(false)
    expect(isSyncableFile('.glovebox.json')).toBe(false)
    expect(isSyncableFile('docs/.glovebox-tmp-123')).toBe(false)
    expect(isSyncableFile('images/logo.png')).toBe(false)
    expect(isSyncableFile('notes/todo.txt')).toBe(false)
  })

  it('allows markdown files only', () => {
    expect(isSyncableFile('readme.md')).toBe(true)
    expect(isSyncableFile('docs/guide.markdown')).toBe(true)
    expect(isSyncableFile('.secret.md')).toBe(true)
  })
})
