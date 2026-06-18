import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api, authClient, errorMessage, safe } from '../lib/api.ts'
import { useUiState } from '../state/ui.ts'
import { WorkspaceProvider } from '../state/workspace.tsx'
import { SignIn } from './SignIn.tsx'
import { Sidebar } from './Sidebar.tsx'
import { EditorView } from './EditorView.tsx'
import { CommandBar } from './CommandBar.tsx'
import { SettingsModal } from './SettingsModal.tsx'

export function AppShell() {
  return (
    <AuthGate>
      {(user) => (
        <ConnectedApp user={user}>
          <div className="flex h-screen overflow-hidden">
            <Sidebar />
            <EditorView />
            <CommandBar />
            <SettingsModal />
          </div>
        </ConnectedApp>
      )}
    </AuthGate>
  )
}

interface GateUser {
  id: string
  name: string
  email: string
}

function ConnectedApp({ user, children }: { user: GateUser; children: ReactNode }) {
  const { autoSync } = useUiState()
  return (
    <WorkspaceProvider user={user} autoSync={autoSync}>
      {children}
    </WorkspaceProvider>
  )
}

function AuthGate({ children }: { children: (user: GateUser) => ReactNode }) {
  const session = authClient.useSession()

  if (session.isPending) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--gb-bg)] text-sm text-[var(--gb-text-muted)]">
        Loading…
      </div>
    )
  }

  const user = session.data?.user
  if (!user) return <SignIn />

  return <>{children({ id: user.id, name: user.name ?? '', email: user.email })}</>
}

/** Device authorization approval page (`/device?user_code=…`), used by the CLI flow. */
export function DevicePage() {
  const [userCode, setUserCode] = useState(
    () => new URLSearchParams(window.location.search).get('user_code') ?? '',
  )
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function approve() {
    setState('busy')
    setError(null)
    const { error } = await safe(api.auth.deviceApprove({ userCode: userCode.trim() }))
    if (error) {
      setError(errorMessage(error))
      setState('idle')
      return
    }
    setState('done')
  }

  return (
    <AuthGate>
      {() => (
        <CenteredCard title="Device authorization">
          {state === 'done' ? (
            <p className="text-sm text-emerald-400">
              Device approved. You can return to your terminal.
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-[var(--gb-text-muted)]">
                Enter the code shown by the Glovebox CLI to authorize it on your account.
              </p>
              <input
                value={userCode}
                onChange={(e) => setUserCode(e.target.value)}
                placeholder="ABCD-EFGH"
                aria-label="Device code"
                className="w-full rounded-md border border-[var(--gb-border)] bg-[var(--gb-bg)] px-3 py-2 text-center font-mono text-sm tracking-widest text-[var(--gb-text)] outline-none focus:border-[var(--gb-accent)]"
              />
              {error && <p className="text-xs text-red-400">{error}</p>}
              <button
                type="button"
                onClick={() => void approve()}
                disabled={state === 'busy' || !userCode.trim()}
                className="w-full rounded-full bg-[var(--gb-accent)] px-3 py-2 text-sm font-semibold text-white hover:bg-[var(--gb-accent-hover)] disabled:opacity-40"
              >
                {state === 'busy' ? 'Approving…' : 'Approve device'}
              </button>
            </div>
          )}
        </CenteredCard>
      )}
    </AuthGate>
  )
}

/** Invite acceptance page (`/invites/accept?token=…`) linked from invite emails. */
export function InviteAcceptPage() {
  return (
    <AuthGate>
      {() => <InviteAcceptInner token={new URLSearchParams(window.location.search).get('token')} />}
    </AuthGate>
  )
}

type InviteAcceptResult =
  | { status: 'busy' }
  | { status: 'done'; workspaceId: string }
  | { status: 'error'; message: string }

function InviteAcceptInner({ token }: { token: string | null }) {
  // One discriminated state: each async outcome commits in a single set.
  const [result, setResult] = useState<InviteAcceptResult>(
    token ? { status: 'busy' } : { status: 'error', message: 'Missing invite token' },
  )

  useEffect(() => {
    if (!token) return
    let cancelled = false
    void (async () => {
      const result = await safe(api.invites.accept({ inviteToken: token }))
      if (cancelled) return
      if (!result.isSuccess) {
        setResult({ status: 'error', message: errorMessage(result.error) })
        return
      }
      localStorage.setItem('glovebox.activeWorkspace', result.data.workspaceId)
      setResult({ status: 'done', workspaceId: result.data.workspaceId })
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  return (
    <CenteredCard title="Workspace invite">
      {result.status === 'busy' && (
        <p className="text-sm text-[var(--gb-text-muted)]">Accepting invite…</p>
      )}
      {result.status === 'done' && (
        <div className="space-y-3">
          <p className="text-sm text-emerald-400">
            Invite accepted — workspace {result.workspaceId}.
          </p>
          <a
            href="/"
            className="block w-full rounded-full bg-[var(--gb-accent)] px-3 py-2 text-center text-sm font-semibold text-white hover:bg-[var(--gb-accent-hover)]"
          >
            Open workspace
          </a>
        </div>
      )}
      {result.status === 'error' && <p className="text-sm text-red-400">{result.message}</p>}
    </CenteredCard>
  )
}

function CenteredCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-screen items-center justify-center bg-[var(--gb-bg)]">
      <div className="w-full max-w-sm rounded-xl border border-[var(--gb-border)] bg-[var(--gb-surface)] p-6 shadow-2xl">
        <h1 className="mb-4 font-display text-lg font-semibold uppercase tracking-[0.04em] text-[var(--gb-text)]">
          {title}
        </h1>
        {children}
      </div>
    </div>
  )
}
