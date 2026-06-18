import { normalizeWorkspaceMarkdownPath, normalizeWorkspaceRelativePath } from '@glovebox.md/core'

export function requireWorkspaceRelativePath(relativePath: string): string {
  const normalized = normalizeWorkspaceRelativePath(relativePath)
  if (!normalized) {
    throw new Error(`Invalid workspace path: ${relativePath}`)
  }

  return normalized
}

export function requireWorkspaceMarkdownPath(relativePath: string): string {
  const normalized = normalizeWorkspaceMarkdownPath(relativePath)
  if (!normalized) {
    throw new Error(`Invalid markdown workspace path: ${relativePath}`)
  }

  return normalized
}
