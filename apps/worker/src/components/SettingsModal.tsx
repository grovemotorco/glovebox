import { useEffect, useRef, useState } from 'react'
import type { ApiKeyView, DocumentRole, KeyPurpose } from '@glovebox.md/api'
import { api, errorMessage, safe } from '../lib/api.ts'
import { useUiActions, useUiState } from '../state/ui.ts'
import { useWorkspace } from '../state/workspace.tsx'
import type { EditorMode } from '../state/ui.ts'
import { CloseIcon, StarIcon, TrashIcon } from './icons.tsx'
import { Select } from './Select.tsx'
import type { SelectOption } from './Select.tsx'

type Tab = 'general' | 'members' | 'access' | 'danger'

const tabs: { key: Tab; label: string }[] = [
  { key: 'general', label: 'General' },
  { key: 'members', label: 'Members' },
  { key: 'access', label: 'Sync & Access' },
  { key: 'danger', label: 'Danger Zone' },
]

const EDITOR_MODE_OPTIONS: SelectOption[] = [
  { value: 'combined', label: 'Split (editor + preview)' },
  { value: 'editor', label: 'Editor only' },
  { value: 'preview', label: 'Preview only' },
]

const ROLE_OPTIONS: SelectOption[] = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'commenter', label: 'Commenter' },
  { value: 'editor', label: 'Editor' },
]

const KEY_PURPOSE_OPTIONS: SelectOption[] = [
  { value: 'cli', label: 'CLI' },
  { value: 'agent', label: 'Agent' },
  { value: 'api', label: 'API' },
]

// Keys minted from this workspace-specific form are operational sync credentials.
// Match the CLI device flow's least-privilege default: content read + write, while
// keeping owner-only workspace:admin capabilities explicitly opt-in.
const WORKSPACE_SYNC_KEY_SCOPES = ['workspace:read', 'workspace:write'] as const

export function SettingsModal() {
  const { settingsModalOpen } = useUiState()
  const { closeSettingsModal } = useUiActions()
  const { workspace } = useWorkspace()
  const [activeTab, setActiveTab] = useState<Tab>('general')
  const dialogRef = useRef<HTMLDialogElement>(null)

  // Native <dialog> + showModal(): the browser provides the focus trap,
  // Escape-to-close, and ::backdrop. Backdrop clicks land on the <dialog>
  // element itself — a mouse-only dismiss convenience (keyboard users have
  // Escape and the close button), so it's wired imperatively rather than
  // declared as an interactive contract on the dialog markup.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!settingsModalOpen || !dialog) return
    dialog.showModal()
    const onBackdropClick = (event: MouseEvent) => {
      if (event.target === dialog) closeSettingsModal()
    }
    dialog.addEventListener('click', onBackdropClick)
    return () => dialog.removeEventListener('click', onBackdropClick)
  }, [settingsModalOpen, closeSettingsModal])

  if (!settingsModalOpen) return null

  return (
    <dialog
      ref={dialogRef}
      aria-label="Workspace settings"
      onClose={closeSettingsModal}
      className="settings-dialog m-auto w-full max-w-xl bg-transparent p-0 text-[var(--gb-text)] backdrop:bg-black/60 backdrop:backdrop-blur-sm"
    >
      <div className="bg-[var(--gb-surface)] border border-[var(--gb-border)] rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--gb-border)]">
          <div>
            <h2 className="font-display text-base font-semibold uppercase tracking-[0.04em] text-[var(--gb-text)]">
              Workspace Settings
            </h2>
            <p className="text-xs text-[var(--gb-text-muted)] mt-0.5">
              {workspace?.name ?? 'No workspace'}
            </p>
          </div>
          <button
            type="button"
            onClick={closeSettingsModal}
            aria-label="Close settings"
            className="p-1.5 rounded-md text-[var(--gb-text-muted)] hover:text-[var(--gb-text)] hover:bg-[var(--gb-hover)] transition-colors"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[var(--gb-border)] px-5 gap-1">
          {tabs.map((tab) => (
            <button
              type="button"
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors -mb-px ${
                activeTab === tab.key
                  ? 'border-[var(--gb-accent)] text-[var(--gb-text)]'
                  : 'border-transparent text-[var(--gb-text-muted)] hover:text-[var(--gb-text)]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {activeTab === 'general' && <GeneralTab />}
          {activeTab === 'members' && <MembersTab />}
          {activeTab === 'access' && <AccessTab />}
          {activeTab === 'danger' && <DangerTab />}
        </div>
      </div>
    </dialog>
  )
}

function GeneralTab() {
  const { workspace, refreshWorkspaces } = useWorkspace()
  const { editorMode } = useUiState()
  const { setEditorMode } = useUiActions()
  const [name, setName] = useState(workspace?.name ?? '')
  const [slug, setSlug] = useState(workspace?.slug ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setName(workspace?.name ?? '')
    setSlug(workspace?.slug ?? '')
  }, [workspace?.id, workspace?.name, workspace?.slug])

  async function save() {
    if (!workspace) return
    setBusy(true)
    setError(null)
    setSaved(false)
    const { error } = await safe(
      (async () => {
        await api.workspaces.update({
          workspaceId: workspace.id,
          ...(name.trim() && name.trim() !== workspace.name ? { name: name.trim() } : {}),
          ...(slug.trim() && slug.trim() !== workspace.slug ? { slug: slug.trim() } : {}),
        })
        await refreshWorkspaces()
      })(),
    )
    if (error) setError(errorMessage(error))
    else setSaved(true)
    setBusy(false)
  }

  return (
    <div className="space-y-5">
      <SettingsField label="Workspace name">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Workspace name"
          className={fieldClass}
        />
      </SettingsField>

      <SettingsField label="Slug">
        <input
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="my-workspace"
          aria-label="Slug"
          className={fieldClass}
        />
      </SettingsField>

      <SettingsField label="Workspace ID">
        <div className="px-3 py-1.5 rounded-md bg-[var(--gb-bg)] border border-[var(--gb-border)] text-sm font-mono text-[var(--gb-text-muted)]">
          {workspace?.id ?? '—'}
        </div>
      </SettingsField>

      <SettingsField label="Default editor mode">
        <Select
          fullWidth
          ariaLabel="Default editor mode"
          value={editorMode}
          options={EDITOR_MODE_OPTIONS}
          onChange={(value) => setEditorMode(value as EditorMode)}
        />
      </SettingsField>

      {error && (
        <p className="text-xs text-red-400" role="alert" aria-live="assertive">
          {error}
        </p>
      )}
      {saved && (
        <p className="text-xs text-emerald-400" role="status" aria-live="polite">
          Saved.
        </p>
      )}

      <div className="pt-2">
        <ActionButton
          label={busy ? 'Saving…' : 'Save Changes'}
          primary
          disabled={busy || !workspace}
          onClick={() => void save()}
        />
      </div>
    </div>
  )
}

function MembersTab() {
  const { workspace, workspaceId, members, refreshMembers, invites, refreshInvites, principalId } =
    useWorkspace()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<DocumentRole>('editor')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pendingInvites = invites.filter((invite) => invite.status === 'pending')
  const canManage = workspace?.currentPrincipalOwner ?? false

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    const { error } = await safe(action())
    if (error) setError(errorMessage(error))
    setBusy(false)
  }

  const invite = () =>
    run(async () => {
      if (!workspaceId || !email.trim()) return
      await api.invites.create({ workspaceId, email: email.trim(), role, owner: false })
      setEmail('')
      await refreshInvites()
    })

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teammate@example.com"
          aria-label="Invite by email"
          className={`${fieldClass} flex-1`}
        />
        <Select
          ariaLabel="Invite role"
          value={role}
          options={ROLE_OPTIONS}
          onChange={(value) => setRole(value as DocumentRole)}
        />
        <ActionButton
          label="Invite"
          primary
          disabled={busy || !email.trim()}
          onClick={() => void invite()}
        />
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="border border-[var(--gb-border)] rounded-lg overflow-hidden">
        {members.map((member, idx) => {
          const isSelf = member.principal.id === principalId
          return (
            <div
              key={member.principal.id}
              className={`flex items-center gap-3 px-4 py-3 ${idx > 0 ? 'border-t border-[var(--gb-border)]' : ''}`}
            >
              <div className="w-8 h-8 rounded-full bg-[var(--gb-accent)]/15 text-[var(--gb-accent)] flex items-center justify-center text-[10px] font-bold flex-shrink-0">
                {member.principal.displayName
                  .split(/\s+/)
                  .map((part) => part[0]?.toUpperCase() ?? '')
                  .slice(0, 2)
                  .join('') || '?'}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm text-[var(--gb-text)] truncate">
                  {member.principal.displayName}
                  {isSelf && (
                    <span className="ml-1 text-[10px] text-[var(--gb-text-muted)]">(you)</span>
                  )}
                </div>
                <div className="text-[11px] text-[var(--gb-text-muted)] truncate">
                  {member.principal.email ?? member.principal.type}
                  {member.owner ? ' · owner' : ''}
                </div>
              </div>
              <Select
                size="sm"
                ariaLabel={`Role for ${member.principal.displayName}`}
                value={member.role}
                options={ROLE_OPTIONS}
                disabled={busy || !canManage}
                onChange={(value) =>
                  void run(async () => {
                    if (!workspaceId) return
                    await api.members.setDocumentRole({
                      workspaceId,
                      principalId: member.principal.id,
                      role: value as DocumentRole,
                    })
                    await refreshMembers()
                  })
                }
              />
              {canManage && !isSelf && (
                <>
                  <button
                    type="button"
                    title={member.owner ? 'Revoke owner' : 'Make owner'}
                    aria-label={member.owner ? 'Revoke owner' : 'Make owner'}
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        if (!workspaceId) return
                        await api.members.setOwner({
                          workspaceId,
                          principalId: member.principal.id,
                          owner: !member.owner,
                        })
                        await refreshMembers()
                      })
                    }
                    className={`inline-flex items-center justify-center rounded border p-1.5 transition-colors disabled:opacity-40 ${
                      member.owner
                        ? 'border-amber-400/40 text-amber-400 hover:bg-amber-400/10'
                        : 'border-[var(--gb-border)] text-[var(--gb-text-muted)] hover:bg-[var(--gb-hover)]'
                    }`}
                  >
                    <StarIcon size={14} />
                  </button>
                  <button
                    type="button"
                    title="Remove member"
                    aria-label="Remove member"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        if (!workspaceId) return
                        if (!window.confirm(`Remove ${member.principal.displayName}?`)) return
                        await api.members.remove({
                          workspaceId,
                          principalId: member.principal.id,
                        })
                        await refreshMembers()
                      })
                    }
                    className="inline-flex items-center justify-center rounded border border-red-500/30 p-1.5 text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-40"
                  >
                    <TrashIcon size={14} />
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>

      {pendingInvites.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-[var(--gb-text)] mb-2">Pending invites</h3>
          <div className="border border-[var(--gb-border)] rounded-lg overflow-hidden">
            {pendingInvites.map((inv, idx) => (
              <div
                key={inv.id}
                className={`flex items-center gap-3 px-4 py-2.5 ${idx > 0 ? 'border-t border-[var(--gb-border)]' : ''}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-mono text-[var(--gb-text)] truncate">
                    {inv.email}
                  </div>
                  <div className="text-[10px] text-[var(--gb-text-muted)] capitalize">
                    {inv.role} · expires {new Date(inv.expiresAt).toLocaleDateString()}
                  </div>
                </div>
                <ActionButton
                  label="Resend"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (!workspaceId) return
                      await api.invites.resend({ workspaceId, inviteId: inv.id })
                    })
                  }
                />
                <ActionButton
                  label="Cancel"
                  danger
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (!workspaceId) return
                      await api.invites.cancel({ workspaceId, inviteId: inv.id })
                      await refreshInvites()
                    })
                  }
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function AccessTab() {
  const { workspaceId } = useWorkspace()
  const { autoSync } = useUiState()
  const { setAutoSync } = useUiActions()
  const [keys, setKeys] = useState<ApiKeyView[]>([])
  const [keyName, setKeyName] = useState('')
  const [purpose, setPurpose] = useState<KeyPurpose>('cli')
  const [plaintext, setPlaintext] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function refreshKeys() {
    const result = await api.keys.list()
    setKeys(result.keys)
  }

  useEffect(() => {
    void refreshKeys().catch(() => {})
  }, [])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    const { error } = await safe(action())
    if (error) setError(errorMessage(error))
    setBusy(false)
  }

  const createKey = () =>
    run(async () => {
      if (!workspaceId || !keyName.trim()) return
      const result = await api.keys.create({
        name: keyName.trim(),
        purpose,
        scopes: [...WORKSPACE_SYNC_KEY_SCOPES],
        workspaceIds: [workspaceId],
      })
      setPlaintext(result.plaintext)
      setKeyName('')
      await refreshKeys()
    })

  return (
    <div className="space-y-5">
      <SettingsToggle
        label="Auto-sync"
        description="Keep this workspace connected and sync edits in real-time."
        checked={autoSync}
        onChange={setAutoSync}
      />

      <div className="border-t border-[var(--gb-border)] pt-5">
        <h3 className="text-xs font-semibold text-[var(--gb-text)] mb-1">API keys</h3>
        <p className="text-[11px] text-[var(--gb-text-muted)] mb-3">
          Keys authenticate the Glovebox CLI and agents (Bearer gbx_…).
        </p>

        <div className="flex items-center gap-2 mb-3">
          <input
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            placeholder="Key name"
            aria-label="Key name"
            className={`${fieldClass} flex-1`}
          />
          <Select
            ariaLabel="API key purpose"
            value={purpose}
            options={KEY_PURPOSE_OPTIONS}
            onChange={(value) => setPurpose(value as KeyPurpose)}
          />
          <ActionButton
            label="Create"
            primary
            disabled={busy || !workspaceId || !keyName.trim()}
            onClick={() => void createKey()}
          />
        </div>

        {plaintext && (
          <div className="mb-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
            <p className="text-[11px] text-emerald-400 mb-1.5">
              Copy this key now — it is shown only once.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-[var(--gb-bg)] px-2 py-1 text-[11px] font-mono text-[var(--gb-text)]">
                {plaintext}
              </code>
              <ActionButton
                label="Copy"
                onClick={() => void navigator.clipboard.writeText(plaintext)}
              />
              <ActionButton label="Done" onClick={() => setPlaintext(null)} />
            </div>
          </div>
        )}

        {error && <p className="mb-2 text-xs text-red-400">{error}</p>}

        <div className="border border-[var(--gb-border)] rounded-lg overflow-hidden">
          {keys.length === 0 && (
            <p className="px-4 py-3 text-xs text-[var(--gb-text-muted)]">No API keys yet.</p>
          )}
          {keys.map((key, idx) => (
            <div
              key={key.id}
              className={`flex items-center gap-3 px-4 py-2.5 ${idx > 0 ? 'border-t border-[var(--gb-border)]' : ''}`}
            >
              <div className="min-w-0 flex-1">
                <div className="text-xs text-[var(--gb-text)] truncate">{key.name}</div>
                <div className="text-[10px] font-mono text-[var(--gb-text-muted)] truncate">
                  {key.prefix}… · {key.purpose}
                  {key.lastUsedAt ? ` · used ${new Date(key.lastUsedAt).toLocaleDateString()}` : ''}
                </div>
              </div>
              <ActionButton
                label="Revoke"
                danger
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (!window.confirm(`Revoke key "${key.name}"?`)) return
                    await api.keys.delete({ keyId: key.id })
                    await refreshKeys()
                  })
                }
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function DangerTab() {
  const { workspace, workspaceId, principalId, refreshWorkspaces } = useWorkspace()
  const { closeSettingsModal, setActiveFile } = useUiActions()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    const { error } = await safe(
      (async () => {
        await action()
        setActiveFile(null)
        closeSettingsModal()
        await refreshWorkspaces()
      })(),
    )
    if (error) setError(errorMessage(error))
    setBusy(false)
  }

  return (
    <div className="space-y-5">
      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="border border-red-500/30 rounded-lg p-4 bg-red-500/5">
        <h3 className="text-sm font-semibold text-red-400 mb-1">Leave workspace</h3>
        <p className="text-xs text-[var(--gb-text-muted)] mb-3">
          You will lose access to all files in this workspace. This cannot be undone.
        </p>
        <ActionButton
          label={busy ? 'Working…' : 'Leave workspace'}
          danger
          disabled={busy || !workspaceId}
          onClick={() =>
            void run(async () => {
              if (!workspaceId) return
              if (!window.confirm(`Leave "${workspace?.name}"?`)) return
              await api.members.remove({ workspaceId, principalId })
            })
          }
        />
      </div>

      <div className="border border-red-500/30 rounded-lg p-4 bg-red-500/5">
        <h3 className="text-sm font-semibold text-red-400 mb-1">Delete workspace</h3>
        <p className="text-xs text-[var(--gb-text-muted)] mb-3">
          Permanently delete this workspace and all its files. All members will lose access.
        </p>
        <ActionButton
          label={busy ? 'Working…' : 'Delete workspace'}
          danger
          disabled={busy || !workspaceId}
          onClick={() =>
            void run(async () => {
              if (!workspaceId) return
              if (!window.confirm(`Delete "${workspace?.name}" and all its files?`)) return
              await api.workspaces.delete({ workspaceId })
            })
          }
        />
      </div>
    </div>
  )
}

/* ── Shared sub-components ── */

const fieldClass =
  'w-full px-3 py-1.5 rounded-md bg-[var(--gb-bg)] border border-[var(--gb-border)] text-sm text-[var(--gb-text)] outline-none focus:border-[var(--gb-accent)] transition-colors'

function SettingsField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-[var(--gb-text-muted)] mb-1.5">
        {label}
      </label>
      {children}
    </div>
  )
}

function SettingsToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  onChange?: (value: boolean) => void
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-[var(--gb-text)]">{label}</div>
        <div className="text-[11px] text-[var(--gb-text-muted)] mt-0.5">{description}</div>
      </div>
      <label className="relative inline-flex items-center cursor-pointer mt-0.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange?.(e.target.checked)}
          aria-label={label}
          className="sr-only peer"
        />
        <div className="w-8 h-[18px] rounded-full bg-zinc-600 peer-checked:bg-emerald-500/70 transition-colors" />
        <div className="absolute left-0.5 top-[3px] w-3 h-3 rounded-full bg-white transition-transform peer-checked:translate-x-3.5" />
      </label>
    </div>
  )
}

function ActionButton({
  label,
  primary,
  danger,
  disabled,
  onClick,
}: {
  label: string
  primary?: boolean
  danger?: boolean
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40 ${
        danger
          ? 'border border-red-500/30 bg-red-500/15 text-red-400 hover:bg-red-500/25'
          : primary
            ? 'bg-[var(--gb-accent)] text-white hover:bg-[var(--gb-accent-hover)]'
            : 'border border-[var(--gb-border)] bg-[var(--gb-bg)] text-[var(--gb-text-muted)] hover:bg-[var(--gb-hover)] hover:text-[var(--gb-text)]'
      }`}
    >
      {label}
    </button>
  )
}
