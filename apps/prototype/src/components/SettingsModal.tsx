import { useState } from 'react'
import { useAppState, useActions } from '../data/store.ts'

type Tab = 'general' | 'members' | 'sync' | 'danger'

const tabs: { key: Tab; label: string }[] = [
  { key: 'general', label: 'General' },
  { key: 'members', label: 'Members' },
  { key: 'sync', label: 'Sync & Sharing' },
  { key: 'danger', label: 'Danger Zone' },
]

export function SettingsModal() {
  const { settingsModalOpen, workspace } = useAppState()
  const { closeSettingsModal } = useActions()
  const [activeTab, setActiveTab] = useState<Tab>('general')

  if (!settingsModalOpen) return null

  return (
    <div
      className="settings-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeSettingsModal()
      }}
    >
      <div className="settings-dialog w-full max-w-xl bg-[var(--gb-surface)] border border-[var(--gb-border)] rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--gb-border)]">
          <div>
            <h2 className="text-sm font-semibold text-[var(--gb-text)]">Workspace Settings</h2>
            <p className="text-xs text-[var(--gb-text-muted)] mt-0.5">{workspace.name}</p>
          </div>
          <button
            onClick={closeSettingsModal}
            className="p-1.5 rounded-md text-[var(--gb-text-muted)] hover:text-[var(--gb-text)] hover:bg-[var(--gb-hover)] transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[var(--gb-border)] px-5 gap-1">
          {tabs.map((tab) => (
            <button
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
          {activeTab === 'sync' && <SyncTab />}
          {activeTab === 'danger' && <DangerTab />}
        </div>
      </div>
    </div>
  )
}

function GeneralTab() {
  const { workspace } = useAppState()

  return (
    <div className="space-y-5">
      <SettingsField label="Workspace name">
        <input
          type="text"
          defaultValue={workspace.name}
          className="w-full px-3 py-1.5 rounded-md bg-[var(--gb-bg)] border border-[var(--gb-border)] text-sm text-[var(--gb-text)] outline-none focus:border-[var(--gb-accent)] transition-colors"
        />
      </SettingsField>

      <SettingsField label="Workspace ID">
        <div className="px-3 py-1.5 rounded-md bg-[var(--gb-bg)] border border-[var(--gb-border)] text-sm font-mono text-[var(--gb-text-muted)]">
          {workspace.id}
        </div>
      </SettingsField>

      <SettingsField label="Description">
        <textarea
          defaultValue="Documentation workspace for the Glovebox project."
          rows={3}
          className="w-full px-3 py-1.5 rounded-md bg-[var(--gb-bg)] border border-[var(--gb-border)] text-sm text-[var(--gb-text)] outline-none focus:border-[var(--gb-accent)] transition-colors resize-none"
        />
      </SettingsField>

      <SettingsField label="Default editor mode">
        <select className="w-full px-3 py-1.5 rounded-md bg-[var(--gb-bg)] border border-[var(--gb-border)] text-sm text-[var(--gb-text)] outline-none focus:border-[var(--gb-accent)] transition-colors">
          <option>Split (editor + preview)</option>
          <option>Editor only</option>
          <option>Preview only</option>
        </select>
      </SettingsField>

      <div className="pt-2">
        <PlaceholderButton label="Save Changes" primary />
      </div>
    </div>
  )
}

function MembersTab() {
  const { workspace } = useAppState()

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--gb-text-muted)]">
          {workspace.members.length} members in this workspace
        </p>
        <PlaceholderButton label="Invite member" primary />
      </div>

      <div className="border border-[var(--gb-border)] rounded-lg overflow-hidden">
        {workspace.members.map((member, idx) => (
          <div
            key={member.id}
            className={`flex items-center gap-3 px-4 py-3 ${idx > 0 ? 'border-t border-[var(--gb-border)]' : ''}`}
          >
            <div className="w-8 h-8 rounded-full bg-[var(--gb-accent)]/15 text-[var(--gb-accent)] flex items-center justify-center text-[10px] font-bold flex-shrink-0">
              {member.avatar}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm text-[var(--gb-text)]">{member.name}</div>
              <div className="text-[11px] text-[var(--gb-text-muted)] capitalize">
                {member.status}
              </div>
            </div>
            <select
              defaultValue={member.role}
              className="px-2 py-1 rounded bg-[var(--gb-bg)] border border-[var(--gb-border)] text-xs text-[var(--gb-text-muted)] outline-none"
            >
              <option value="owner">Owner</option>
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>
        ))}
      </div>
    </div>
  )
}

function SyncTab() {
  const { workspace } = useAppState()
  const [linkEnabled, setLinkEnabled] = useState(workspace.invite.linkEnabled)
  const [codeEnabled, setCodeEnabled] = useState(workspace.invite.codeEnabled)

  return (
    <div className="space-y-5">
      <SettingsToggle
        label="Auto-sync"
        description="Automatically sync changes across devices in real-time."
        checked={workspace.invite.syncEnabled}
      />

      <div className="border-t border-[var(--gb-border)] pt-5">
        <h3 className="text-xs font-semibold text-[var(--gb-text)] mb-3">Share Link</h3>
        <SettingsToggle
          label="Enable share link"
          description="Anyone with the link can request to join this workspace."
          checked={linkEnabled}
          onChange={setLinkEnabled}
        />
        {linkEnabled && (
          <div className="mt-3 flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={workspace.invite.shareLink}
              className="flex-1 px-3 py-1.5 rounded-md bg-[var(--gb-bg)] border border-[var(--gb-border)] text-xs font-mono text-[var(--gb-text-muted)] outline-none"
            />
            <PlaceholderButton label="Copy" />
            <PlaceholderButton label="Regenerate" />
          </div>
        )}
      </div>

      <div className="border-t border-[var(--gb-border)] pt-5">
        <h3 className="text-xs font-semibold text-[var(--gb-text)] mb-3">Invite Code</h3>
        <SettingsToggle
          label="Enable invite code"
          description="Share a short code that people can enter to join."
          checked={codeEnabled}
          onChange={setCodeEnabled}
        />
        {codeEnabled && (
          <div className="mt-3 flex items-center gap-2">
            <div className="px-3 py-1.5 rounded-md bg-[var(--gb-bg)] border border-[var(--gb-border)] text-sm font-mono font-semibold tracking-wider text-[var(--gb-text)]">
              {workspace.invite.inviteCode}
            </div>
            <PlaceholderButton label="Copy" />
            <PlaceholderButton label="Regenerate" />
          </div>
        )}
      </div>
    </div>
  )
}

function DangerTab() {
  return (
    <div className="space-y-5">
      <div className="border border-red-500/30 rounded-lg p-4 bg-red-500/5">
        <h3 className="text-sm font-semibold text-red-400 mb-1">Leave workspace</h3>
        <p className="text-xs text-[var(--gb-text-muted)] mb-3">
          You will lose access to all files in this workspace. This cannot be undone.
        </p>
        <PlaceholderButton label="Leave workspace" danger />
      </div>

      <div className="border border-red-500/30 rounded-lg p-4 bg-red-500/5">
        <h3 className="text-sm font-semibold text-red-400 mb-1">Delete workspace</h3>
        <p className="text-xs text-[var(--gb-text-muted)] mb-3">
          Permanently delete this workspace and all its files. All members will lose access.
        </p>
        <PlaceholderButton label="Delete workspace" danger />
      </div>
    </div>
  )
}

/* ── Shared sub-components ── */

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
          className="sr-only peer"
        />
        <div className="w-8 h-[18px] rounded-full bg-zinc-600 peer-checked:bg-emerald-500/70 transition-colors" />
        <div className="absolute left-0.5 top-[3px] w-3 h-3 rounded-full bg-white transition-transform peer-checked:translate-x-3.5" />
      </label>
    </div>
  )
}

function PlaceholderButton({
  label,
  primary,
  danger,
}: {
  label: string
  primary?: boolean
  danger?: boolean
}) {
  return (
    <button
      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
        danger
          ? 'bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25'
          : primary
            ? 'bg-[var(--gb-accent)] text-white hover:bg-[var(--gb-accent-hover)]'
            : 'bg-[var(--gb-bg)] text-[var(--gb-text-muted)] border border-[var(--gb-border)] hover:text-[var(--gb-text)] hover:bg-[var(--gb-hover)]'
      }`}
    >
      {label}
    </button>
  )
}
