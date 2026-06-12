import { memoryAdapter, type MemoryDB } from '@better-auth/memory-adapter'
import { betterAuth } from 'better-auth'
import { describe, expect, it } from 'vitest'
import type { Env } from '../src/dispatcher.ts'
import { createAuthOptions } from '../src/lib/auth.ts'
import type { AuthEmailMessage } from '../src/lib/auth-email.ts'

describe('Better Auth flows', () => {
  it('signs up, verifies email, and authenticates with the session cookie', async () => {
    const { fetch, emails } = await createAuthHarness()

    const signUp = await post(fetch, '/sign-up/email', {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'correct horse battery staple',
    })

    expect(signUp.status).toBe(200)
    expect(await jsonObject(signUp)).toMatchObject({
      token: null,
      user: { email: 'ada@example.com', emailVerified: false },
    })
    expect(emails).toHaveLength(1)
    expect(emails[0]).toMatchObject({
      to: 'ada@example.com',
      subject: 'Verify your Glovebox email',
    })

    const verificationUrl = authEmailUrl(emails[0])
    verificationUrl.searchParams.delete('callbackURL')
    const verified = await fetch(verificationUrl)
    const cookieHeaders = convertSetCookieToCookie(new Headers(verified.headers))

    expect(verified.status).toBe(200)
    expect(await jsonObject(verified)).toMatchObject({ status: true })
    expect(cookieHeaders.get('cookie')).toContain('better-auth.session_token=')

    const session = await fetch(authUrl('/get-session'), { headers: cookieHeaders })

    expect(session.status).toBe(200)
    expect(await jsonObject(session)).toMatchObject({
      user: { email: 'ada@example.com', emailVerified: true },
    })
  })

  it('sends and verifies magic-link login emails', async () => {
    const { fetch, emails } = await createAuthHarness()

    const requested = await post(fetch, '/sign-in/magic-link', {
      email: 'grace@example.com',
      name: 'Grace Hopper',
    })

    expect(requested.status).toBe(200)
    expect(await jsonObject(requested)).toEqual({ status: true })
    expect(emails).toHaveLength(1)
    expect(emails[0]).toMatchObject({
      to: 'grace@example.com',
      subject: 'Sign in to Glovebox',
    })

    const magicUrl = authEmailUrl(emails[0])
    magicUrl.searchParams.delete('callbackURL')
    const verified = await fetch(magicUrl)
    const body = await jsonObject(verified)

    expect(verified.status).toBe(200)
    expect(body).toMatchObject({
      user: { email: 'grace@example.com', emailVerified: true },
      session: {},
    })
    expect(typeof body.token).toBe('string')
  })

  it('authenticates sessions through Better Auth API keys with gbx_ bearer tokens', async () => {
    const harness = await createAuthHarness()
    const { fetch } = harness
    const cookieHeaders = await verifiedSessionHeaders(harness, 'linus@example.com')
    const created = await post(
      fetch,
      '/api-key/create',
      {
        name: 'CLI key',
      },
      cookieHeaders,
    )
    const apiKey = await jsonObject(created)

    expect(created.status).toBe(200)
    expect(apiKey.key).toEqual(expect.stringMatching(/^gbx_/))

    const session = await fetch(authUrl('/get-session'), {
      headers: { authorization: `Bearer ${String(apiKey.key)}` },
    })

    expect(session.status).toBe(200)
    expect(await jsonObject(session)).toMatchObject({
      user: { email: 'linus@example.com' },
    })
  })

  it('runs the device authorization start, claim, approve, and bearer poll flow', async () => {
    const harness = await createAuthHarness()
    const { fetch } = harness
    const cookieHeaders = await verifiedSessionHeaders(harness, 'margaret@example.com')
    const started = await post(fetch, '/device/code', {
      client_id: 'glovebox-cli',
      scope: 'workspace:read',
    })
    const device = await jsonObject(started)

    expect(started.status).toBe(200)
    expect(device).toMatchObject({
      verification_uri: 'https://api.glovebox.test/device',
      expires_in: expect.any(Number),
      interval: expect.any(Number),
    })
    expect(typeof device.device_code).toBe('string')
    expect(typeof device.user_code).toBe('string')

    const pending = await post(fetch, '/device/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: 'glovebox-cli',
    })

    expect(pending.status).toBe(400)
    expect(await jsonObject(pending)).toMatchObject({ error: 'authorization_pending' })

    const claimed = await fetch(authUrl(`/device?user_code=${String(device.user_code)}`), {
      headers: cookieHeaders,
    })

    expect(claimed.status).toBe(200)
    expect(await jsonObject(claimed)).toMatchObject({ status: 'pending' })

    const approved = await post(
      fetch,
      '/device/approve',
      { userCode: device.user_code },
      cookieHeaders,
    )

    expect(approved.status).toBe(200)
    expect(await jsonObject(approved)).toEqual({ success: true })

    await sleep(1_100)

    const token = await post(fetch, '/device/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: 'glovebox-cli',
    })
    const tokenBody = await jsonObject(token)

    expect(token.status).toBe(200)
    expect(tokenBody).toMatchObject({
      token_type: 'Bearer',
      scope: 'workspace:read',
    })
    expect(typeof tokenBody.access_token).toBe('string')

    const session = await fetch(authUrl('/get-session'), {
      headers: { authorization: `Bearer ${String(tokenBody.access_token)}` },
    })

    expect(session.status).toBe(200)
    expect(await jsonObject(session)).toMatchObject({
      user: { email: 'margaret@example.com' },
    })
  })
})

type AuthHarness = {
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>
  emails: AuthEmailMessage[]
}

async function createAuthHarness(): Promise<AuthHarness> {
  const emails: AuthEmailMessage[] = []
  const db: MemoryDB = {
    account: [],
    apikey: [],
    deviceCode: [],
    jwks: [],
    session: [],
    user: [],
    verification: [],
  }
  const auth = betterAuth({
    database: memoryAdapter(db),
    ...createAuthOptions(testEnv(emails), { deviceInterval: '0s' }),
  })

  return {
    fetch: (url, init) => auth.handler(new Request(url, init)),
    emails,
  }
}

function testEnv(emails: AuthEmailMessage[]): Env {
  return {
    AUTH_EMAIL_MODE: 'fake',
    FAKE_AUTH_EMAILS: emails,
    BETTER_AUTH_SECRET: 'test-auth-secret-that-is-long-enough',
    BETTER_AUTH_URL: 'https://api.glovebox.test',
    BETTER_AUTH_TRUSTED_ORIGIN: 'https://api.glovebox.test,https://api.glovebox.test',
  } as Env
}

async function verifiedSessionHeaders(harness: AuthHarness, email: string): Promise<Headers> {
  const { fetch, emails } = harness
  const signedUp = await post(fetch, '/sign-up/email', {
    name: email.split('@')[0] ?? 'Test User',
    email,
    password: 'correct horse battery staple',
  })
  expect(signedUp.status).toBe(200)

  const latestEmail = emails.findLast((item) => item.subject === 'Verify your Glovebox email')
  const url = authEmailUrl(latestEmail)
  url.searchParams.delete('callbackURL')
  const verified = await fetch(url)

  expect(verified.status).toBe(200)
  return convertSetCookieToCookie(new Headers(verified.headers))
}

function convertSetCookieToCookie(headers: Headers): Headers {
  const cookies = headers.getSetCookie?.() ?? []
  if (cookies.length === 0) {
    const setCookie = headers.get('set-cookie')
    if (setCookie) {
      cookies.push(setCookie)
    }
  }
  if (cookies.length === 0) {
    return headers
  }

  headers.set(
    'cookie',
    cookies
      .map((cookie) => cookie.split(';', 1)[0])
      .filter(Boolean)
      .join('; '),
  )
  return headers
}

function post(
  fetch: AuthHarness['fetch'],
  path: string,
  body: Record<string, unknown>,
  headers?: Headers,
): Promise<Response> {
  const requestHeaders = new Headers(headers)
  requestHeaders.set('content-type', 'application/json')
  requestHeaders.set('origin', 'https://api.glovebox.test')

  return fetch(authUrl(path), {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body),
  })
}

function authUrl(path: string): string {
  return `https://api.glovebox.test/api/auth${path}`
}

function authEmailUrl(message: AuthEmailMessage | undefined): URL {
  if (!message) {
    throw new Error('expected auth email')
  }

  const url = /https:\/\/\S+/.exec(message.text)?.[0]
  if (!url) {
    throw new Error('auth email did not include a URL')
  }
  return new URL(url)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function jsonObject(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json()
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected JSON object response')
  }
  return value as Record<string, unknown>
}
