export function isMarkdownFile(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.markdown')
}

export function isSyncableFile(name: string): boolean {
  const basename = name.split('/').pop() ?? name
  return isMarkdownFile(basename) && !basename.startsWith('.glovebox-tmp-')
}
