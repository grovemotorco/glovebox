import { useState } from 'react'
import type { FormEvent } from 'react'
import { authClient, errorMessage } from '../lib/api.ts'

type Mode = 'sign-in' | 'sign-up'

/**
 * Session gate. Email + password works out of the box in dev
 * (BETTER_AUTH_DEV_PASSWORD); the magic-link flow needs a configured email
 * sender (AUTH_EMAIL_MODE=send).
 */
export function SignIn() {
  const [mode, setMode] = useState<Mode>('sign-in')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result =
        mode === 'sign-in'
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({ email, password, name: name || email.split('@')[0]! })
      if (result.error) {
        setError(result.error.message ?? 'Authentication failed')
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleMagicLink() {
    if (!email) {
      setError('Enter your email first')
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await authClient.signIn.magicLink({ email, callbackURL: '/' })
      if (result.error) {
        setError(result.error.message ?? 'Could not send magic link')
      } else {
        setNotice(`Magic link sent to ${email}`)
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-[var(--gb-bg)]">
      <div className="w-full max-w-sm rounded-xl border border-[var(--gb-border)] bg-[var(--gb-surface)] p-6 shadow-2xl">
        <div className="mb-6 text-center">
          <h1 className="font-display text-3xl font-bold uppercase tracking-[0.02em] text-[var(--gb-text)]">
            Glovebox
          </h1>
          <p className="mt-1 text-xs text-[var(--gb-text-muted)]">
            Real-time file sync &amp; collaborative markdown
          </p>
        </div>

        <div className="mb-5 flex rounded-md border border-[var(--gb-border)] overflow-hidden">
          {(
            [
              { key: 'sign-in', label: 'Sign in' },
              { key: 'sign-up', label: 'Create account' },
            ] as const
          ).map((tab) => (
            <button
              type="button"
              key={tab.key}
              onClick={() => {
                setMode(tab.key)
                setError(null)
                setNotice(null)
              }}
              className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
                mode === tab.key
                  ? 'bg-[var(--gb-accent)] text-white'
                  : 'text-[var(--gb-text-muted)] hover:text-[var(--gb-text)] hover:bg-[var(--gb-hover)]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === 'sign-up' && (
            <Field label="Name">
              <input
                type="text"
                name="name"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ada Lovelace"
                aria-label="Name"
                className={inputClass}
              />
            </Field>
          )}
          <Field label="Email">
            <input
              type="email"
              name="email"
              required
              autoComplete="email"
              inputMode="email"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              aria-label="Email"
              className={inputClass}
            />
          </Field>
          <Field label="Password">
            <input
              type="password"
              name="password"
              required
              minLength={8}
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              aria-label="Password"
              className={inputClass}
            />
          </Field>

          {error && (
            <p className="text-xs text-red-400" role="alert" aria-live="assertive">
              {error}
            </p>
          )}
          {notice && (
            <p className="text-xs text-emerald-400" role="status" aria-live="polite">
              {notice}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-full bg-[var(--gb-accent)] px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--gb-accent-hover)] disabled:opacity-40"
          >
            {busy ? 'Working…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <div className="mt-4 border-t border-[var(--gb-border)] pt-4">
          <button
            type="button"
            onClick={() => void handleMagicLink()}
            disabled={busy}
            className="w-full rounded-full border border-[var(--gb-border)] bg-[var(--gb-bg)] px-3 py-2 text-xs text-[var(--gb-text-muted)] transition-colors hover:bg-[var(--gb-hover)] hover:text-[var(--gb-text)] disabled:opacity-40"
          >
            Email me a magic link instead
          </button>
        </div>
      </div>
    </div>
  )
}

const inputClass =
  'w-full rounded-md border border-[var(--gb-border)] bg-[var(--gb-bg)] px-3 py-1.5 text-sm text-[var(--gb-text)] outline-none transition-colors placeholder:text-[var(--gb-text-muted)]/50 focus:border-[var(--gb-accent)]'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-[var(--gb-text-muted)]">{label}</span>
      {children}
    </label>
  )
}
