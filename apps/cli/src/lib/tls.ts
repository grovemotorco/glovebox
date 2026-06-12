import { isIP } from 'node:net'
import { connect, getCACertificates, setDefaultCACertificates } from 'node:tls'

/**
 * Local-dev TLS trust. Browsers and curl read the OS trust store; Node
 * uses its bundled CA list, so a locally-trusted dev CA (portless/mkcert
 * for `.test` domains) passes in the browser and fails in the daemon with
 * an error undici's WebSocket reports as an EMPTY ErrorEvent — invisible.
 * Two countermeasures:
 *
 * - `ensureSystemCaTrust()` augments Node's default CA store with the OS
 *   store at startup (same semantics as `--use-system-ca`, scoped to this
 *   process) — with `portless trust` installed, wss to `.test` just works.
 * - `diagnoseTlsTrust()` is a preflight used AFTER a connection failure to
 *   name the actual TLS error, because the WebSocket layer won't.
 */

let augmented = false

/** Add the OS trust store to Node's default CAs (idempotent, best-effort). */
export function ensureSystemCaTrust(): boolean {
  if (augmented) {
    return true
  }
  try {
    const system = getCACertificates('system')
    if (system.length === 0) {
      return false
    }
    setDefaultCACertificates([...getCACertificates('default'), ...system])
    augmented = true
    return true
  } catch {
    return false
  }
}

const CERT_TRUST_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_SIGNATURE_FAILURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

export interface TlsDiagnosis {
  code: string
  message: string
  /** True when the failure is a certificate-trust problem (hintable). */
  certTrust: boolean
}

/**
 * Probe the server's TLS handshake directly and report what failed.
 * `null` = handshake fine (or not an https URL, or probe timed out) —
 * the connection problem lies elsewhere.
 */
export function diagnoseTlsTrust(
  serverUrl: string,
  timeoutMs = 3_000,
): Promise<TlsDiagnosis | null> {
  let url: URL
  try {
    url = new URL(serverUrl)
  } catch {
    return Promise.resolve(null)
  }
  if (url.protocol !== 'https:') {
    return Promise.resolve(null)
  }
  const port = url.port ? Number(url.port) : 443

  return new Promise((resolve) => {
    const socket = connect({
      host: url.hostname,
      port,
      // SNI is only legal for hostnames, never IP literals.
      servername: isIP(url.hostname) ? undefined : url.hostname,
      rejectUnauthorized: true,
      ALPNProtocols: ['http/1.1'],
    })
    const finish = (result: TlsDiagnosis | null): void => {
      socket.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    socket.on('secureConnect', () => {
      clearTimeout(timer)
      finish(null)
    })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      const code = error.code ?? 'TLS_ERROR'
      finish({ code, message: error.message, certTrust: CERT_TRUST_CODES.has(code) })
    })
  })
}

export const TLS_TRUST_HINT =
  'Node rejected the TLS certificate (browsers use the OS trust store; Node may not). ' +
  'For local dev: `portless trust` to install the dev CA system-wide, or run with ' +
  'NODE_EXTRA_CA_CERTS=~/.portless/ca.pem (or NODE_OPTIONS=--use-system-ca).'
