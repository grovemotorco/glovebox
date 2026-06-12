import { createServer } from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import { diagnoseTlsTrust, ensureSystemCaTrust } from '../../src/lib/tls.ts'

// Throwaway self-signed localhost cert, generated for this test only
// (100-year expiry; never trusted anywhere).
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUWLJ0aGIOGNbp4F9zsvZ+tpcKFtswDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDYxMDE2MTI0N1oYDzIxMjYw
NTE3MTYxMjQ3WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDCOul7lenmi2vukCMDOAk9sEsWQd1yLRtRgKVYz5ca
fyvWgrWq2o6Su41cqmjT9fdwCQemvZQAtFuHMOc56dZFw1VGNJw5EzVgXilLsbXZ
Cuw86lkBjoVYva9qotMK+49KnNbodUDB0RDnEqb41Z0O7mlMptxA/umIi9SdTKcJ
amyjB2WyWzO7K7lr6Jucu7U/Jc30BnBMVbe7hFmGbmwp62miUe3R93LuOYIwPUBt
6Z08nkhMws77th3LxiV3dD1vvmcl7cSaEWF+ihI+NKkpwZr0EXtbzJgj5nEWxTa0
eYZyPxPVIIUMThERMe1NPHl9DnDavRgV4PeYIKnh7O5fAgMBAAGjbzBtMB0GA1Ud
DgQWBBSg2nx/WN4q9F0jJ7zVqEjsitd38TAfBgNVHSMEGDAWgBSg2nx/WN4q9F0j
J7zVqEjsitd38TAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z
dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAr3H5EEbV/t5Pct+x0bkyr8y5bYpz
xxorrXuzp/rHVZT0eZZ4ZN8Lt78WgWTLnwOQW1Xx9cV4tp5tkbg3vNoNANz3ev0x
tSiBV1mpxeHMUqHdZfzYYpWkhHAGdtbJCI/F6rFOKA6Rx2D/XAvULq4u2zm2HXEh
OAdRRYZS8PL1Y47qZW+h9dBvXJvYZxCSlOdJa4p4h6DeyY7Xpa852P7MH8ExMuzY
PghKYDTttxOVzL+KReVnlNcIe/n6FCUgYl1VogRkktdtlLxw2l09hUVYAC4UzfVY
SZGSNsuBDOgTNwNqEEKGhcvHavK1ccf/BuqzUBoOEEKJHmkss52XuStUag==
-----END CERTIFICATE-----`

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDCOul7lenmi2vu
kCMDOAk9sEsWQd1yLRtRgKVYz5cafyvWgrWq2o6Su41cqmjT9fdwCQemvZQAtFuH
MOc56dZFw1VGNJw5EzVgXilLsbXZCuw86lkBjoVYva9qotMK+49KnNbodUDB0RDn
Eqb41Z0O7mlMptxA/umIi9SdTKcJamyjB2WyWzO7K7lr6Jucu7U/Jc30BnBMVbe7
hFmGbmwp62miUe3R93LuOYIwPUBt6Z08nkhMws77th3LxiV3dD1vvmcl7cSaEWF+
ihI+NKkpwZr0EXtbzJgj5nEWxTa0eYZyPxPVIIUMThERMe1NPHl9DnDavRgV4PeY
IKnh7O5fAgMBAAECggEAAcAWj8ON5EL7Y2uVgf234s0IHP8I9NkNNvkDngvfRVQO
3BPSrH1KhzrJ2/Afmh4yvAxVlYR92Fr672DBPkqQk/f3q8NLnFDc/62GWvIS1nR8
i1JjucAQ2ZGtpANfOk+CchF89xyFy3lYpdk+lSpJP3PMke4RbBCGbQswv+rx7AOV
rVUZzDl1BihJxtQpScnMHgr07KNsKdp680xtQzxZkkTeKJVAsuyg/fgZlvOCpJx9
mMlRhLyG1CQYTKky14EcFKtkmZteLX0hXvGuNh/f0rTVIs3sAjkM73MDAHEdO92N
iJLCkJLQN1G094Yb6lj56VjnY6Yx268lkPo4cLDvOQKBgQDyi23HNtndLG1s2Aji
zLzmMsX0SyYW2yDz/6i0nt471nVkdupFGWTfIBmLtFjnDK1yD6iVx85ZoSCg5lFh
JAiazoVzcb0++qbupV9zQ+BDtYCPD82T0wS1ROooI5B/qPM1+HClvFpMoBzwxNGC
nSI7S963idcF8qPGLfHf2+CnywKBgQDNAVR4Mny48jdvjOD4udoXrazYtUvYlfHA
Ghn9/w0br2x44XPCptUE8D3NdOnQLmA6ksW2IvlUCPQjMJM83n6gjuYLdRePvbYE
i2HGri1oaPXHpkF4rghQ7Q1tgrd/6wVnkViOdiaKB1D9yCOhBNjaGLuVtMY1Ywq3
eQNDK4J5PQKBgET5K43EZm5ELRYP1W8RxAI+nBadrEZBqHxaztIWf6JKmXWpb3OZ
BhuBmGInNkT2UPinxUxa1q6caJf5B1l1ktDbPA4ZYTTguMoS0zMHMWZv3hBQ8ShB
kQwvfdtOSdBT7l4BuZ8YEiHKQpChl+bp4os0RzCwjSpO1w4LkMYVVCzDAoGAHX0K
fHuuqx/UT4xxM/Xv5CYMTePONCplat+WS43rgcb7EGxFrYM38wznpu0hUNvK5cIF
BI0FVkwvafxrwX6zsj674nwGVpvQWdj+yIh3aaRnbj+A/W3zLkja/Jyn7pOM5Hfo
yB1Ar+wbf1XRojDDTKPwH7mwJS/I89lJWdkhXHUCgYEA1W/kmsCCN+HS76DZQIZ5
/lIaiXeyTZIupCt67TmB1CCgWBBvuaddws6F0kpEz2X3k1KDOw5/E59a03gamAXp
ASPxaiFAMSqcmciVIpWQxIh86QaFzNRbSXn0HzsQmwO7eTLxZB+3M83nsb8YdtcN
zbGyi7Sqq+ESGX+1o0BTo5Q=
-----END PRIVATE KEY-----`

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
})

describe('TLS trust diagnostics', () => {
  it('ensureSystemCaTrust is callable and idempotent', () => {
    const first = ensureSystemCaTrust()
    expect(typeof first).toBe('boolean')
    expect(ensureSystemCaTrust()).toBe(first)
  })

  it('non-https URLs are not diagnosed', async () => {
    expect(await diagnoseTlsTrust('http://127.0.0.1:1')).toBeNull()
    expect(await diagnoseTlsTrust('not a url')).toBeNull()
  })

  it('names a self-signed certificate as a cert-trust failure', async () => {
    const server = createServer({ cert: TEST_CERT, key: TEST_KEY })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise((resolve) => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('no address')
    }

    const diagnosis = await diagnoseTlsTrust(`https://127.0.0.1:${address.port}`)
    expect(diagnosis).not.toBeNull()
    expect(diagnosis!.certTrust).toBe(true)
    expect(diagnosis!.code).toBe('DEPTH_ZERO_SELF_SIGNED_CERT')
  })
})
