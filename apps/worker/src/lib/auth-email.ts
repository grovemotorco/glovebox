import type { Env } from '../dispatcher.ts'

export interface AuthEmailMessage {
  to: string
  subject: string
  text: string
  html: string
}

export type AuthEmailMode = 'send' | 'fake' | 'none'

const DEFAULT_AUTH_EMAIL_FROM = 'auth@glovebox.test'
const DEFAULT_AUTH_EMAIL_FROM_NAME = 'Glovebox'
const DEFAULT_INVITATION_EMAIL_FROM = 'invites@glovebox.test'
const DEFAULT_INVITATION_EMAIL_FROM_NAME = 'Glovebox'
export const DEFAULT_INVITATION_ACCEPT_URL = 'https://api.glovebox.test/invites/accept'

export async function sendAuthEmail(env: Env, message: AuthEmailMessage): Promise<void> {
  await sendEmail(env, message, {
    email: env.AUTH_EMAIL_FROM ?? DEFAULT_AUTH_EMAIL_FROM,
    name: env.AUTH_EMAIL_FROM_NAME ?? DEFAULT_AUTH_EMAIL_FROM_NAME,
  })
}

export async function sendInvitationEmail(env: Env, message: AuthEmailMessage): Promise<void> {
  await sendEmail(env, message, {
    email: env.INVITATION_EMAIL_FROM ?? DEFAULT_INVITATION_EMAIL_FROM,
    name: env.INVITATION_EMAIL_FROM_NAME ?? DEFAULT_INVITATION_EMAIL_FROM_NAME,
  })
}

async function sendEmail(
  env: Env,
  message: AuthEmailMessage,
  from: { email: string; name: string },
): Promise<void> {
  const mode = authEmailMode(env)

  if (mode === 'none') {
    return
  }

  if (mode === 'fake') {
    env.FAKE_AUTH_EMAILS?.push(message)
    return
  }

  if (!env.EMAIL) {
    throw new Error('Cloudflare Email Service binding EMAIL is required for auth email')
  }

  await env.EMAIL.send({
    to: message.to,
    from,
    subject: message.subject,
    text: message.text,
    html: message.html,
  })
}

export function verificationEmailMessage(to: string, url: string): AuthEmailMessage {
  return authLinkEmailMessage({
    to,
    subject: 'Verify your Glovebox email',
    action: 'Verify your Glovebox email',
    url,
  })
}

export function magicLinkEmailMessage(to: string, url: string): AuthEmailMessage {
  return authLinkEmailMessage({
    to,
    subject: 'Sign in to Glovebox',
    action: 'Sign in to Glovebox',
    url,
  })
}

export function invitationEmailMessage(input: {
  to: string
  workspaceName: string
  inviteToken: string
  acceptUrl: string
}): AuthEmailMessage {
  const browserUrl = new URL(input.acceptUrl || DEFAULT_INVITATION_ACCEPT_URL)
  browserUrl.searchParams.set('token', input.inviteToken)
  const cliCommand = `glovebox invites accept ${input.inviteToken}`
  const escapedWorkspaceName = escapeHtml(input.workspaceName)
  const escapedBrowserUrl = escapeHtml(browserUrl.toString())
  const escapedCliCommand = escapeHtml(cliCommand)

  return {
    to: input.to,
    subject: `Join ${input.workspaceName} on Glovebox`,
    text: [
      `You have been invited to ${input.workspaceName} on Glovebox.`,
      `Open ${browserUrl.toString()} to accept in your browser.`,
      `CLI: ${cliCommand}`,
    ].join('\n'),
    html: `<p>You have been invited to <strong>${escapedWorkspaceName}</strong> on Glovebox.</p><p><a href="${escapedBrowserUrl}">Accept invitation</a></p><p>CLI: <code>${escapedCliCommand}</code></p>`,
  }
}

function authEmailMode(env: Env): AuthEmailMode {
  if (env.AUTH_EMAIL_MODE) {
    return env.AUTH_EMAIL_MODE
  }
  if (env.FAKE_AUTH_EMAILS) {
    return 'fake'
  }
  if (env.BETTER_AUTH_DEV_PASSWORD === 'true') {
    return 'none'
  }
  return 'send'
}

function authLinkEmailMessage(input: {
  to: string
  subject: string
  action: string
  url: string
}): AuthEmailMessage {
  const escapedUrl = escapeHtml(input.url)
  const escapedAction = escapeHtml(input.action)

  return {
    to: input.to,
    subject: input.subject,
    text: `${input.action}: ${input.url}`,
    html: `<p>${escapedAction}:</p><p><a href="${escapedUrl}">${escapedUrl}</a></p>`,
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
