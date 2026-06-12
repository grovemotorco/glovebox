/**
 * INV-13: text is normalized to `\n` at every boundary — sidecar file read,
 * editor ingest, DO push ingress, mirror write. A CRLF flip from a
 * Windows-side editor corrupts position bookkeeping and silently breaks the
 * `lastWrittenHash` watermark (INV-4).
 */
export function normalizeEol(text: string): string {
  if (!text.includes('\r')) return text
  return text.replace(/\r\n?/g, '\n')
}
