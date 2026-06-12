/** Convert an HTTP(S) base URL to its WebSocket equivalent. */
export function toWsBase(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws').replace(/\/$/, '')
}
