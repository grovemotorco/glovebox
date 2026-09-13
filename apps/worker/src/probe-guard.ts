/**
 * Segments that indicate scanner/credential probe requests. These paths appear
 * in automated scanner traffic (Spring Boot actuator probes, dotfile leaks,
 * PHP env dumps, etc.) and have no legitimate meaning in glovebox-worker, which
 * has no such routes. Letting them fall through to the SSR pipeline cold-boots
 * React unnecessarily and pushes the isolate toward the 128 MB memory limit.
 */
const PROBE_SUBSTRINGS: ReadonlyArray<string> = [
  'actuator',
  'configprops',
  'phpinfo',
  'secrets',
  'docker-compose',
  'config.php',
  'user_secrets',
  'service-account',
]

/**
 * Returns true when the request pathname matches a known credential/actuator
 * probe signature: any path segment that starts with `.` (dotfiles, `.env`,
 * `.git`, …) or that equals or contains one of the well-known probe strings.
 *
 * The check is performed on the lowercased pathname so it is case-insensitive.
 */
export function isProbeRequest(pathname: string): boolean {
  const segments = pathname.toLowerCase().split('/').filter(Boolean)
  return segments.some(
    (seg) => seg.startsWith('.') || PROBE_SUBSTRINGS.some((sub) => seg.includes(sub)),
  )
}

/** A ready-made 403 response with an empty body for probe rejections. */
export function probeRejectResponse(): Response {
  return new Response(null, { status: 403 })
}

const PAGE_ROUTES: ReadonlySet<string> = new Set(['/', '/device', '/invites/accept'])

const EXACT_KNOWN_PATHS: ReadonlySet<string> = new Set([
  '/healthz',
  '/openapi.json',
  '/docs',
  '/robots.txt',
  '/sitemap.xml',
  '/favicon.ico',
])

/**
 * Returns true when the pathname should not reach the SSR pipeline.
 *
 * Called in the dispatcher **after** all specific route handlers (/api/*,
 * /ws/*, /admin/*, /healthz, /openapi.json, /docs) have already run. At that
 * point the only paths that should proceed to SSR are the page routes and
 * client-side assets; everything else is unknown.
 *
 * Known paths that may still reach SSR:
 *  - Page routes: `/`, `/device`, `/invites/accept` (exact, trailing-slash tolerant)
 *  - Static assets: `/assets/*`, `/robots.txt`, `/sitemap.xml`, `/favicon.ico`
 *
 * Everything else is unknown and should be rejected cheaply (404) instead of
 * falling through to SSR, which cold-boots React and pushes the isolate
 * toward the 128 MB memory limit on every probe request.
 */
export function isUnknownPath(pathname: string): boolean {
  const normalized = pathname !== '/' && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  if (PAGE_ROUTES.has(normalized)) return false
  if (EXACT_KNOWN_PATHS.has(normalized)) return false
  if (pathname.startsWith('/assets/')) return false
  return true
}
