import { useState } from 'react'
import { useAppState, useActions } from '../data/store.ts'
import { FileTree } from './FileTree.tsx'
import type { Member } from '../data/mock.ts'

export function Sidebar() {
  const { workspace, sidebarOpen } = useAppState()
  const { toggleSidebar, openSettingsModal } = useActions()
  const [membersPanelOpen, setMembersPanelOpen] = useState(true)
  const [syncPanelOpen, setSyncPanelOpen] = useState(false)

  const onlineCount = workspace.members.filter((m) => m.status === 'online').length

  return (
    <aside
      className={`flex flex-col border-r border-[var(--gb-border)] bg-[var(--gb-sidebar-bg)] transition-all duration-200 ease-in-out overflow-hidden ${sidebarOpen ? 'w-64' : 'w-0'}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-[var(--gb-border)]">
        <div className="min-w-0">
          <h2 className="text-xs font-bold uppercase tracking-wider text-[var(--gb-text-muted)]">
            Workspace
          </h2>
          <p className="text-sm font-semibold text-[var(--gb-text)] mt-0.5 truncate">
            {workspace.name}
          </p>
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            onClick={openSettingsModal}
            className="p-1.5 rounded-md text-[var(--gb-text-muted)] hover:text-[var(--gb-text)] hover:bg-[var(--gb-hover)] transition-colors"
            title="Workspace settings"
          >
            <SettingsIcon />
          </button>
          <button
            onClick={toggleSidebar}
            className="p-1.5 rounded-md text-[var(--gb-text-muted)] hover:text-[var(--gb-text)] hover:bg-[var(--gb-hover)] transition-colors"
            title="Collapse sidebar"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M10 12L6 8l4-4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Status + Stats */}
      <div className="px-4 py-2.5 border-b border-[var(--gb-border)]">
        <div className="flex items-center gap-2 text-xs text-[var(--gb-text-muted)]">
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
              workspace.status === 'connected'
                ? 'bg-emerald-500'
                : workspace.status === 'syncing'
                  ? 'bg-amber-400'
                  : 'bg-red-400'
            }`}
          />
          <span className="capitalize">{workspace.status}</span>
          <span className="opacity-40">·</span>
          <span className="truncate">{workspace.deviceName}</span>
        </div>

        {/* Stats row */}
        <div className="flex items-center gap-3 mt-2">
          <StatBadge icon={<FileCountIcon />} label={`${workspace.stats.totalFiles} files`} />
          <StatBadge icon={<SizeIcon />} label={workspace.stats.totalSize} />
          <StatBadge icon={<FolderCountIcon />} label={`${workspace.stats.folders} dirs`} />
        </div>

        <div className="text-[10px] text-[var(--gb-text-muted)] opacity-60 mt-1.5">
          Last sync {formatRelative(workspace.lastSync)}
        </div>
      </div>

      {/* Members */}
      <div className="border-b border-[var(--gb-border)]">
        <button
          onClick={() => setMembersPanelOpen(!membersPanelOpen)}
          className="flex items-center justify-between w-full px-4 py-2 text-left hover:bg-[var(--gb-hover)] transition-colors"
        >
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--gb-text-muted)]">
            Members
          </span>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-emerald-400 font-medium">{onlineCount} online</span>
            <span
              className="text-[10px] text-[var(--gb-text-muted)] transition-transform duration-150"
              style={{
                display: 'inline-block',
                transform: membersPanelOpen ? 'rotate(90deg)' : 'rotate(0deg)',
              }}
            >
              ▶
            </span>
          </div>
        </button>
        {membersPanelOpen && (
          <div className="px-3 pb-2.5 space-y-0.5">
            {workspace.members.map((member) => (
              <MemberRow key={member.id} member={member} />
            ))}
          </div>
        )}
      </div>

      {/* Sync & Invite */}
      <div className="border-b border-[var(--gb-border)]">
        <button
          onClick={() => setSyncPanelOpen(!syncPanelOpen)}
          className="flex items-center justify-between w-full px-4 py-2 text-left hover:bg-[var(--gb-hover)] transition-colors"
        >
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--gb-text-muted)]">
            Share & Sync
          </span>
          <span
            className="text-[10px] text-[var(--gb-text-muted)] transition-transform duration-150"
            style={{
              display: 'inline-block',
              transform: syncPanelOpen ? 'rotate(90deg)' : 'rotate(0deg)',
            }}
          >
            ▶
          </span>
        </button>
        {syncPanelOpen && (
          <div className="px-4 pb-3 space-y-2.5">
            {/* Sync toggle */}
            <InlineToggle
              icon={<SyncIcon />}
              label="Auto-sync"
              enabled={workspace.invite.syncEnabled}
            />

            {/* Share link */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5 text-[11px] text-[var(--gb-text-muted)]">
                  <LinkIcon />
                  <span>Share link</span>
                </div>
                <TogglePill enabled={workspace.invite.linkEnabled} />
              </div>
              {workspace.invite.linkEnabled && <CopyField value={workspace.invite.shareLink} />}
            </div>

            {/* Invite code */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5 text-[11px] text-[var(--gb-text-muted)]">
                  <CodeIcon />
                  <span>Invite code</span>
                </div>
                <TogglePill enabled={workspace.invite.codeEnabled} />
              </div>
              {workspace.invite.codeEnabled && <CopyField value={workspace.invite.inviteCode} />}
            </div>
          </div>
        )}
      </div>

      {/* File tree */}
      <nav className="flex-1 overflow-y-auto p-2">
        <FileTree entries={workspace.tree} depth={0} />
      </nav>
    </aside>
  )
}

function MemberRow({ member }: { member: Member }) {
  const statusColor =
    member.status === 'online'
      ? 'bg-emerald-500'
      : member.status === 'idle'
        ? 'bg-amber-400'
        : 'bg-zinc-600'

  return (
    <div className="flex items-center gap-2.5 px-1 py-1 rounded-md hover:bg-[var(--gb-hover)] transition-colors">
      <div className="relative flex-shrink-0">
        <div className="w-6 h-6 rounded-full bg-[var(--gb-accent)]/15 text-[var(--gb-accent)] flex items-center justify-center text-[9px] font-bold">
          {member.avatar}
        </div>
        <span
          className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border-2 border-[var(--gb-sidebar-bg)] ${statusColor}`}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-[var(--gb-text)] truncate">{member.name}</div>
      </div>
      <span className="text-[9px] text-[var(--gb-text-muted)] opacity-60 uppercase tracking-wide">
        {member.role}
      </span>
    </div>
  )
}

function StatBadge({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-1 text-[10px] text-[var(--gb-text-muted)]">
      {icon}
      <span>{label}</span>
    </div>
  )
}

function InlineToggle({
  icon,
  label,
  enabled,
}: {
  icon: React.ReactNode
  label: string
  enabled: boolean
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-1.5 text-[11px] text-[var(--gb-text-muted)]">
        {icon}
        <span>{label}</span>
      </div>
      <TogglePill enabled={enabled} />
    </div>
  )
}

function TogglePill({ enabled }: { enabled: boolean }) {
  return (
    <div
      className={`w-7 h-4 rounded-full relative cursor-pointer transition-colors ${enabled ? 'bg-emerald-500/70' : 'bg-zinc-600'}`}
    >
      <div
        className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${enabled ? 'translate-x-3.5' : 'translate-x-0.5'}`}
      />
    </div>
  )
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="flex items-center gap-1">
      <div className="flex-1 min-w-0 px-2 py-1 rounded bg-[var(--gb-bg)] border border-[var(--gb-border)] text-[10px] font-mono text-[var(--gb-text-muted)] truncate">
        {value}
      </div>
      <button
        onClick={handleCopy}
        className="flex-shrink-0 px-1.5 py-1 rounded bg-[var(--gb-bg)] border border-[var(--gb-border)] text-[10px] text-[var(--gb-text-muted)] hover:text-[var(--gb-text)] hover:bg-[var(--gb-hover)] transition-colors"
      >
        {copied ? '✓' : 'Copy'}
      </button>
    </div>
  )
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/* ── Icons ── */

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M6.86 1.45a1.2 1.2 0 012.28 0l.25.76a1.2 1.2 0 001.5.72l.74-.28a1.2 1.2 0 011.62 1.14l-.04.79a1.2 1.2 0 00.96 1.24l.77.16a1.2 1.2 0 01.56 2.04l-.56.56a1.2 1.2 0 000 1.56l.56.56a1.2 1.2 0 01-.56 2.04l-.77.16a1.2 1.2 0 00-.96 1.24l.04.79a1.2 1.2 0 01-1.62 1.14l-.74-.28a1.2 1.2 0 00-1.5.72l-.25.76a1.2 1.2 0 01-2.28 0l-.25-.76a1.2 1.2 0 00-1.5-.72l-.74.28a1.2 1.2 0 01-1.62-1.14l.04-.79a1.2 1.2 0 00-.96-1.24l-.77-.16a1.2 1.2 0 01-.56-2.04l.56-.56a1.2 1.2 0 000-1.56l-.56-.56a1.2 1.2 0 01.56-2.04l.77-.16a1.2 1.2 0 00.96-1.24l-.04-.79a1.2 1.2 0 011.62-1.14l.74.28a1.2 1.2 0 001.5-.72l.25-.76z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <circle cx="8" cy="8" r="2.25" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function FileCountIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M3 1.5h4.5L10 4v6.5a1 1 0 01-1 1H3a1 1 0 01-1-1v-8a1 1 0 011-1z"
        stroke="currentColor"
        strokeWidth="1"
      />
      <path d="M7.5 1.5V4H10" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

function SizeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <rect x="1.5" y="2.5" width="9" height="7" rx="1" stroke="currentColor" strokeWidth="1" />
      <path d="M4 5.5h4M4 7.5h2.5" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
    </svg>
  )
}

function FolderCountIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M1.5 9.5V3a1 1 0 011-1h2.293a1 1 0 01.707.293L6.5 3.5h4a1 1 0 011 1v5a1 1 0 01-1 1h-8a1 1 0 01-1-1z"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  )
}

function SyncIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M1.5 6a4.5 4.5 0 017.94-2.9M10.5 6a4.5 4.5 0 01-7.94 2.9"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
      />
      <path
        d="M9 1.5l.44 1.6H7.8M3 10.5l-.44-1.6H4.2"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function LinkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M5 7l2-2M4.17 8.83a2.12 2.12 0 010-3l.66-.66a2.12 2.12 0 013 3M7.83 3.17a2.12 2.12 0 010 3l-.66.66a2.12 2.12 0 01-3-3"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
      />
    </svg>
  )
}

function CodeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M4 3.5L1.5 6 4 8.5M8 3.5L10.5 6 8 8.5"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M6.75 2.5l-1.5 7" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
    </svg>
  )
}
