/**
 * SSR stand-ins for the `#app-shell` alias. The real implementations live in
 * AppShell.client.tsx and depend on browser-only modules (WebSocket, Loro
 * WASM, CodeMirror); all app routes render with `ssr: false`, so the server
 * only ever needs these to satisfy module resolution.
 */
export function AppShell() {
  return null
}

export function DevicePage() {
  return null
}

export function InviteAcceptPage() {
  return null
}
