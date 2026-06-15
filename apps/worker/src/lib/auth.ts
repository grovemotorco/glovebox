import { apiKey } from '@better-auth/api-key'
import { betterAuth } from 'better-auth'
import type { BetterAuthOptions } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { bearer, deviceAuthorization, magicLink } from 'better-auth/plugins'
import type { Env } from '../dispatcher.ts'
import type { Database } from '../db/index.ts'
import { magicLinkEmailMessage, sendAuthEmail, verificationEmailMessage } from './auth-email.ts'
import { bootstrapPersonalWorkspaceForUser } from './workspace-bootstrap.ts'

export const API_KEY_DEFAULT_PREFIX = 'gbx_'
export const API_KEY_MAX_NAME_LENGTH = 120
export const API_KEY_RATE_LIMIT = {
  enabled: false,
  timeWindow: 60_000,
  maxRequests: 1_200,
} as const

const API_KEY_BEARER_RE = /^bearer\s+(gbx_\S+)\s*$/i
const IS_LOCAL_DEV = Boolean(import.meta.env.DEV) && !import.meta.env.VITEST
const LOCAL_DEV_ORIGINS = ['http://api.glovebox.test:4813', 'http://127.0.0.1:4813']

export function createAuth(db: Database, env: Env) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite' }),
    ...createAuthOptions(env, { db }),
  })
}

export function createAuthOptions(
  env: Env,
  options: { db?: Database; deviceInterval?: `${number}s` } = {},
): BetterAuthOptions {
  const configuredBaseURL = env.BETTER_AUTH_URL ?? 'https://api.glovebox.test'
  const baseURL =
    IS_LOCAL_DEV && configuredBaseURL === 'https://api.glovebox.test'
      ? 'http://api.glovebox.test:4813'
      : configuredBaseURL
  const configuredTrustedOrigins = (env.BETTER_AUTH_TRUSTED_ORIGIN ?? baseURL)
    .split(',')
    .flatMap((origin) => {
      const trimmed = origin.trim()
      return trimmed ? [trimmed] : []
    })
  const trustedOrigins = [
    ...new Set([...configuredTrustedOrigins, ...(IS_LOCAL_DEV ? LOCAL_DEV_ORIGINS : [])]),
  ]
  const webOrigin = trustedOrigins[0]?.replace(/\/$/, '') ?? baseURL.replace(/\/$/, '')
  const devPasswordAuthEnabled = env.BETTER_AUTH_DEV_PASSWORD === 'true'
  const allowInsecureCookies =
    IS_LOCAL_DEV && trustedOrigins.some((origin) => origin.startsWith('http://'))
  const cookieDomain = allowInsecureCookies ? undefined : env.BETTER_AUTH_COOKIE_DOMAIN

  return {
    secret: env.BETTER_AUTH_SECRET ?? 'glovebox-dev-auth-secret-change-me',
    baseURL,
    basePath: '/api/auth',
    trustedOrigins,
    ...(options.db
      ? {
          databaseHooks: {
            user: {
              create: {
                after: async (user) => {
                  await bootstrapPersonalWorkspaceForUser(options.db!, {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                  })
                },
              },
            },
          },
        }
      : {}),
    emailAndPassword: {
      enabled: true,
      disableSignUp: false,
      requireEmailVerification: !devPasswordAuthEnabled,
    },
    emailVerification: {
      sendOnSignUp: !devPasswordAuthEnabled,
      sendOnSignIn: !devPasswordAuthEnabled,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendAuthEmail(env, verificationEmailMessage(user.email, url))
      },
    },
    session: {
      cookieCache: { enabled: true, maxAge: 300 },
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      crossSubDomainCookies: {
        enabled: Boolean(cookieDomain),
        domain: cookieDomain,
      },
      defaultCookieAttributes: {
        sameSite: 'lax',
        secure: !allowInsecureCookies,
        httpOnly: true,
      },
    },
    plugins: [
      bearer(),
      apiKey({
        defaultPrefix: API_KEY_DEFAULT_PREFIX,
        maximumNameLength: API_KEY_MAX_NAME_LENGTH,
        apiKeyHeaders: 'authorization',
        customAPIKeyGetter: (ctx) => {
          const header =
            ctx.request?.headers.get('authorization') ?? ctx.headers?.get('authorization')
          return header?.match(API_KEY_BEARER_RE)?.[1] ?? null
        },
        storage: 'database',
        enableSessionForAPIKeys: true,
        enableMetadata: true,
        rateLimit: API_KEY_RATE_LIMIT,
        schema: {},
      }),
      magicLink({
        storeToken: 'hashed',
        sendMagicLink: async ({ email, url }) => {
          await sendAuthEmail(env, magicLinkEmailMessage(email, url))
        },
      }),
      deviceAuthorization({
        verificationUri: `${webOrigin}/device`,
        ...(options.deviceInterval ? { interval: options.deviceInterval } : {}),
        schema: {},
      }),
    ],
  } satisfies BetterAuthOptions
}

export type Auth = ReturnType<typeof createAuth>
