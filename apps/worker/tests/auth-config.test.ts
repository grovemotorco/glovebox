import { describe, expect, it } from 'vitest'
import type { Env } from '../src/dispatcher.ts'
import {
  API_KEY_DEFAULT_PREFIX,
  API_KEY_MAX_NAME_LENGTH,
  API_KEY_RATE_LIMIT,
} from '../src/lib/auth.ts'
import {
  invitationEmailMessage,
  magicLinkEmailMessage,
  sendAuthEmail,
  verificationEmailMessage,
} from '../src/lib/auth-email.ts'
import { generateInviteToken, hashInviteToken } from '../src/lib/invite-token.ts'

describe('Better Auth configuration', () => {
  it('uses the Glovebox API-key policy required by the public API', () => {
    expect(API_KEY_DEFAULT_PREFIX).toBe('gbx_')
    expect(API_KEY_MAX_NAME_LENGTH).toBe(120)
    expect(API_KEY_RATE_LIMIT).toMatchObject({ enabled: false })
  })

  it('records auth emails in fake/no-email mode without touching Cloudflare Email', async () => {
    const messages: Parameters<typeof sendAuthEmail>[1][] = []

    await sendAuthEmail(
      {
        AUTH_EMAIL_MODE: 'fake',
        FAKE_AUTH_EMAILS: messages,
      } as Env,
      authEmailMessage(),
    )

    expect(messages).toEqual([authEmailMessage()])
  })

  it('skips auth email delivery in no-email mode', async () => {
    const sent: unknown[] = []

    await sendAuthEmail(
      {
        AUTH_EMAIL_MODE: 'none',
        EMAIL: {
          send: async (message) => {
            sent.push(message)
          },
        },
      } as Env,
      authEmailMessage(),
    )

    expect(sent).toEqual([])
  })

  it('sends auth emails through the Cloudflare Email binding with text and HTML bodies', async () => {
    const sent: unknown[] = []

    await sendAuthEmail(
      {
        AUTH_EMAIL_MODE: 'send',
        AUTH_EMAIL_FROM: 'login@example.com',
        AUTH_EMAIL_FROM_NAME: 'Glovebox Login',
        EMAIL: {
          send: async (message) => {
            sent.push(message)
          },
        },
      } as Env,
      authEmailMessage(),
    )

    expect(sent).toEqual([
      {
        to: 'person@example.com',
        from: { email: 'login@example.com', name: 'Glovebox Login' },
        subject: 'Sign in',
        text: 'Use this link.',
        html: '<p>Use this link.</p>',
      },
    ])
  })

  it('fails loudly when real auth email is requested without the Email binding', async () => {
    await expect(
      sendAuthEmail({ AUTH_EMAIL_MODE: 'send' } as Env, authEmailMessage()),
    ).rejects.toThrow('Cloudflare Email Service binding EMAIL is required for auth email')
  })

  it('builds verification and magic-link messages with text and HTML links', () => {
    const verification = verificationEmailMessage(
      'person@example.com',
      'https://api.glovebox.test/verify?token=a&next=<home>',
    )
    const magicLink = magicLinkEmailMessage('person@example.com', 'https://api.glovebox.test/login')

    expect(verification).toMatchObject({
      to: 'person@example.com',
      subject: 'Verify your Glovebox email',
      text: 'Verify your Glovebox email: https://api.glovebox.test/verify?token=a&next=<home>',
    })
    expect(verification.html).toContain(
      'https://api.glovebox.test/verify?token=a&amp;next=&lt;home&gt;',
    )
    expect(magicLink).toEqual({
      to: 'person@example.com',
      subject: 'Sign in to Glovebox',
      text: 'Sign in to Glovebox: https://api.glovebox.test/login',
      html: '<p>Sign in to Glovebox:</p><p><a href="https://api.glovebox.test/login">https://api.glovebox.test/login</a></p>',
    })
  })

  it('builds invitation emails with browser and CLI accept instructions', () => {
    const message = invitationEmailMessage({
      to: 'writer@example.com',
      workspaceName: 'Docs <Team>',
      inviteToken: 'secret-token',
      acceptUrl: 'https://api.glovebox.test/invites/accept',
    })

    expect(message).toMatchObject({
      to: 'writer@example.com',
      subject: 'Join Docs <Team> on Glovebox',
    })
    expect(message.text).toContain('https://api.glovebox.test/invites/accept?token=secret-token')
    expect(message.text).toContain('glovebox invites accept secret-token')
    expect(message.html).toContain('Docs &lt;Team&gt;')
    expect(message.html).toContain('glovebox invites accept secret-token')
  })

  it('generates random invitation tokens and stable non-plaintext hashes', async () => {
    const token = generateInviteToken()
    const hash = await hashInviteToken(token)

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(token).toHaveLength(43)
    expect(hash).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(hash).toHaveLength(43)
    expect(hash).not.toBe(token)
    await expect(hashInviteToken(token)).resolves.toBe(hash)
  })
})

function authEmailMessage() {
  return {
    to: 'person@example.com',
    subject: 'Sign in',
    text: 'Use this link.',
    html: '<p>Use this link.</p>',
  }
}
