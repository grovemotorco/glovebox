export const MAX_WORKSPACE_PATH_LENGTH = 1024

export function normalizeWorkspaceRelativePath(input: string): string | null {
  if (!input || input.includes('\0')) {
    return null
  }

  const slashNormalized = input.normalize('NFC').replace(/\\/g, '/')
  if (slashNormalized.startsWith('/')) {
    return null
  }

  const parts = slashNormalized.split('/')
  const normalizedParts: string[] = []

  for (const part of parts) {
    if (!part) {
      continue
    }

    if (part === '.' || part === '..') {
      return null
    }

    normalizedParts.push(part)
  }

  if (normalizedParts.length === 0) {
    return null
  }

  const normalizedPath = normalizedParts.join('/')
  if (normalizedPath.length > MAX_WORKSPACE_PATH_LENGTH) {
    return null
  }

  return normalizedPath
}

export function normalizeWorkspaceMarkdownPath(input: string): string | null {
  const normalized = normalizeWorkspaceRelativePath(input)
  if (!normalized) {
    return null
  }

  const lower = normalized.toLowerCase()
  if (!lower.endsWith('.md') && !lower.endsWith('.markdown')) {
    return null
  }

  return normalized
}
