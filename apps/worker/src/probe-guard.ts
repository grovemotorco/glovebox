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
