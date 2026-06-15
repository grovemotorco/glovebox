import tanstackStart from '@tanstack/react-start/server-entry'
import { createDevAppShellResponse } from '#dev-app-shell'

const IS_VITEST = Boolean(import.meta.env.VITEST)
const IS_DEV = Boolean(import.meta.env.DEV)

export async function handleAppFallback(request: Request): Promise<Response> {
  if (IS_DEV && !IS_VITEST) {
    return createDevAppShellResponse(request)
  }

  try {
    const response = await tanstackStart.fetch(request)
    if (response.status >= 500 && IS_VITEST) {
      return vitestEditorFallbackResponse(request)
    }
    return response
  } catch (error) {
    if (IS_VITEST && isMissingStartVirtualImportError(error)) {
      return vitestEditorFallbackResponse(request)
    }
    throw error
  }
}

function isMissingStartVirtualImportError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('#tanstack-router-entry')
}

function vitestEditorFallbackResponse(request: Request): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Not Found', { status: 404 })
  }
  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Glovebox</title>
  </head>
  <body>
    <main>
      <h1>Glovebox</h1>
      <p>docs/demo.md</p>
      <textarea aria-label="Markdown content"></textarea>
    </main>
  </body>
</html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  )
}
