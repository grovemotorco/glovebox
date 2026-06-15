export function createDevAppShellResponse(_request: Request): Response {
  return new Response('Dev app shell is only available from the Vite dev server.', {
    status: 503,
  })
}
