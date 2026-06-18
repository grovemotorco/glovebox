import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  CommentThread,
  DocumentVersion,
  Suggestion,
  WorkspaceTreeEntry,
} from '@glovebox.md/api'
import { api, errorMessage } from '../lib/api.ts'
import { randomUuid } from '../lib/random.ts'
import { readRoomText, useWorkspace, type RoomHandle } from '../state/workspace.tsx'

type PanelTab = 'comments' | 'suggestions' | 'versions' | 'recovery'

const tabs: { key: PanelTab; label: string }[] = [
  { key: 'comments', label: 'Comments' },
  { key: 'suggestions', label: 'Suggest' },
  { key: 'versions', label: 'Versions' },
  { key: 'recovery', label: 'Recovery' },
]

/**
 * Review data tagged with the workspace+file that produced it. Deriving
 * against the current selection means switching files can neither flash nor
 * be clobbered by the previous file's data — no reset effect needed.
 */
interface ReviewData {
  key: string
  comments: CommentThread[]
  suggestions: Suggestion[]
  versions: DocumentVersion[]
}

const NO_COMMENTS: CommentThread[] = []
const NO_SUGGESTIONS: Suggestion[] = []
const NO_VERSIONS: DocumentVersion[] = []

export function CollaborationPanel({
  activeEntry,
  handle,
}: {
  activeEntry: WorkspaceTreeEntry | null
  handle: RoomHandle | null
}) {
  const { workspaceId, members, recovery, refreshRecovery } = useWorkspace()
  const [activeTab, setActiveTab] = useState<PanelTab>('comments')
  const [reviewData, setReviewData] = useState<ReviewData | null>(null)
  const [commentBody, setCommentBody] = useState('')
  const [suggestionText, setSuggestionText] = useState('')
  const [rangeStart, setRangeStart] = useState(0)
  const [rangeEnd, setRangeEnd] = useState(24)
  const [busy, setBusy] = useState(false)
  const [errorState, setErrorState] = useState<{ key: string | null; message: string } | null>(null)

  const fileId = activeEntry?.fileId ?? null
  const reviewKey = workspaceId && fileId ? `${workspaceId}:${fileId}` : null

  const comments = reviewData?.key === reviewKey ? reviewData.comments : NO_COMMENTS
  const suggestions = reviewData?.key === reviewKey ? reviewData.suggestions : NO_SUGGESTIONS
  const versions = reviewData?.key === reviewKey ? reviewData.versions : NO_VERSIONS
  const error = errorState && errorState.key === reviewKey ? errorState.message : null

  const membersById = useMemo(
    () => new Map(members.map((member) => [member.principal.id, member.principal.displayName])),
    [members],
  )
  const authorName = useCallback(
    (principalId: string) => membersById.get(principalId) ?? principalId,
    [membersById],
  )

  // Versions arrive in insertion order; newest first for display and as the
  // base version that new comments/suggestions anchor to.
  const sortedVersions = useMemo(() => versions.toSorted((a, b) => b.seq - a.seq), [versions])
  const baseVersionId = sortedVersions[0]?.versionId ?? null

  const refreshReviewData = useCallback(async () => {
    if (!workspaceId || !fileId) return
    const key = `${workspaceId}:${fileId}`
    const [commentsResult, suggestionsResult, versionsResult] = await Promise.all([
      api.comments.list({ workspaceId, fileId }),
      api.suggestions.list({ workspaceId, fileId }),
      api.versions.list({ workspaceId, fileId }),
    ])
    setReviewData({
      key,
      comments: commentsResult.threads,
      suggestions: suggestionsResult.suggestions,
      versions: versionsResult.versions,
    })
  }, [workspaceId, fileId])

  useEffect(() => {
    void refreshReviewData().catch((err: unknown) =>
      setErrorState({ key: reviewKey, message: errorMessage(err) }),
    )
  }, [refreshReviewData, reviewKey])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setErrorState(null)
    try {
      await action()
    } catch (err) {
      setErrorState({ key: reviewKey, message: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  /**
   * Record the live text as a D1 version row via the D5 text-push tier.
   * A no-op push bootstraps the FIRST version (comments/suggestions need a
   * base version to anchor to); later pushes mint a row only when the live
   * text actually drifted from the last recorded version.
   */
  const saveVersion = () =>
    run(async () => {
      if (!workspaceId || !fileId) return
      const current = await api.workspaces.readText({ workspaceId, fileId })
      await api.workspaces.textPush({
        workspaceId,
        fileId,
        newText: current.text,
        baseHashHex: current.hashHex,
        idempotencyKey: randomUuid(),
      })
      await refreshReviewData()
    })

  const submitComment = () =>
    run(async () => {
      const body = commentBody.trim()
      if (!workspaceId || !fileId || !baseVersionId || !body) return
      await api.comments.create({
        workspaceId,
        fileId,
        baseVersionId,
        range: clampRange(rangeStart, rangeEnd, readRoomText(handle)),
        body,
      })
      setCommentBody('')
      await refreshReviewData()
    })

  const submitSuggestion = () =>
    run(async () => {
      const replacementText = suggestionText.trim()
      if (!workspaceId || !fileId || !baseVersionId || !replacementText) return
      await api.suggestions.propose({
        workspaceId,
        fileId,
        baseVersionId,
        range: clampRange(rangeStart, rangeEnd, readRoomText(handle)),
        replacementText,
      })
      setSuggestionText('')
      await refreshReviewData()
    })

  const setCommentStatus = (threadId: string, status: 'open' | 'resolved') =>
    run(async () => {
      if (!workspaceId) return
      if (status === 'resolved') {
        await api.comments.resolve({ workspaceId, threadId })
      } else {
        await api.comments.reopen({ workspaceId, threadId })
      }
      await refreshReviewData()
    })

  const deleteCommentThread = (threadId: string) =>
    run(async () => {
      if (!workspaceId) return
      await api.comments.delete({ workspaceId, threadId })
      await refreshReviewData()
    })

  const decideSuggestion = (suggestionId: string, decision: 'accept' | 'reject') =>
    run(async () => {
      if (!workspaceId) return
      if (decision === 'accept') {
        // Server-side merge into the LIVE doc — the editor picks the change
        // up over the workspace socket.
        await api.suggestions.accept({ workspaceId, suggestionId })
      } else {
        await api.suggestions.reject({ workspaceId, suggestionId })
      }
      await refreshReviewData()
    })

  const acknowledgeRecovery = (recordId: string) =>
    run(async () => {
      if (!workspaceId) return
      await api.documents.recoveryAcknowledge({ workspaceId, recordId })
      await refreshRecovery()
    })

  const showComposer = activeTab === 'comments' || activeTab === 'suggestions'

  return (
    <aside className="w-80 flex-shrink-0 border-l border-[var(--gb-border)] bg-[var(--gb-sidebar-bg)] flex flex-col min-h-0">
      <header className="h-11 px-3 border-b border-[var(--gb-border)] flex items-center justify-between">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-[var(--gb-text)]">Review</h2>
          <p className="text-[11px] text-[var(--gb-text-muted)] truncate">
            {activeEntry?.path ?? 'No file'}
          </p>
        </div>
        {recovery.length > 0 && (
          <button
            type="button"
            onClick={() => setActiveTab('recovery')}
            className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/30"
            title="Pending recovery records"
          >
            {recovery.length}
          </button>
        )}
      </header>

      <div className="grid grid-cols-4 border-b border-[var(--gb-border)]">
        {tabs.map((tab) => (
          <button
            type="button"
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`h-9 text-[11px] font-medium border-r border-[var(--gb-border)] last:border-r-0 ${
              activeTab === tab.key
                ? 'bg-[var(--gb-active)] text-[var(--gb-text)]'
                : 'text-[var(--gb-text-muted)] hover:text-[var(--gb-text)] hover:bg-[var(--gb-hover)]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {showComposer && fileId && (
        <div className="p-3 border-b border-[var(--gb-border)]">
          {baseVersionId ? (
            <>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <label className="text-[11px] text-[var(--gb-text-muted)]">
                  Start
                  <input
                    value={rangeStart}
                    min={0}
                    type="number"
                    onChange={(event) => setRangeStart(Number(event.target.value))}
                    className="mt-1 w-full h-8 rounded-md bg-[var(--gb-bg)] border border-[var(--gb-border)] px-2 text-[12px] text-[var(--gb-text)]"
                  />
                </label>
                <label className="text-[11px] text-[var(--gb-text-muted)]">
                  End
                  <input
                    value={rangeEnd}
                    min={0}
                    type="number"
                    onChange={(event) => setRangeEnd(Number(event.target.value))}
                    className="mt-1 w-full h-8 rounded-md bg-[var(--gb-bg)] border border-[var(--gb-border)] px-2 text-[12px] text-[var(--gb-text)]"
                  />
                </label>
              </div>

              {activeTab === 'comments' ? (
                <div className="flex gap-2">
                  <input
                    value={commentBody}
                    onChange={(event) => setCommentBody(event.target.value)}
                    placeholder="Comment"
                    aria-label="Comment"
                    className="min-w-0 flex-1 h-8 rounded-md bg-[var(--gb-bg)] border border-[var(--gb-border)] px-2 text-[12px] text-[var(--gb-text)] placeholder:text-[var(--gb-text-muted)]"
                  />
                  <button
                    type="button"
                    onClick={() => void submitComment()}
                    disabled={busy || !commentBody.trim()}
                    className="h-8 px-3 rounded-md bg-[var(--gb-accent)] text-white text-[12px] font-medium disabled:opacity-40"
                  >
                    Add
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <input
                    value={suggestionText}
                    onChange={(event) => setSuggestionText(event.target.value)}
                    placeholder="Replacement"
                    aria-label="Replacement text"
                    className="min-w-0 flex-1 h-8 rounded-md bg-[var(--gb-bg)] border border-[var(--gb-border)] px-2 text-[12px] text-[var(--gb-text)] placeholder:text-[var(--gb-text-muted)]"
                  />
                  <button
                    type="button"
                    onClick={() => void submitSuggestion()}
                    disabled={busy || !suggestionText.trim()}
                    className="h-8 px-3 rounded-md bg-[var(--gb-accent)] text-white text-[12px] font-medium disabled:opacity-40"
                  >
                    Add
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="text-center">
              <p className="text-[11px] text-[var(--gb-text-muted)] mb-2">
                Reviews anchor to a saved version. Save one to start.
              </p>
              <button
                type="button"
                onClick={() => void saveVersion()}
                disabled={busy}
                className="h-8 px-3 rounded-md bg-[var(--gb-accent)] text-white text-[12px] font-medium disabled:opacity-40"
              >
                {busy ? 'Saving…' : 'Save first version'}
              </button>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="px-3 py-2 border-b border-[var(--gb-border)]">
          <p className="text-[11px] text-red-400">{error}</p>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
        {!fileId && activeTab !== 'recovery' && (
          <p className="text-[11px] text-[var(--gb-text-muted)] opacity-60">
            Open a file to review it.
          </p>
        )}

        {activeTab === 'comments' &&
          comments.map((comment) => (
            <article
              key={comment.id}
              className="rounded-md border border-[var(--gb-border)] bg-[var(--gb-bg)] p-3"
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-[12px] font-medium text-[var(--gb-text)] truncate">
                  {authorName(comment.authorPrincipalId)}
                </span>
                <span className="text-[10px] uppercase text-[var(--gb-text-muted)]">
                  {comment.status}
                </span>
              </div>
              <p className="text-[12px] leading-5 text-[var(--gb-text)]">{comment.body}</p>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-[11px] text-[var(--gb-text-muted)]">
                  {comment.range.start}-{comment.range.end}
                  {comment.range.stale ? ' (stale)' : ''}
                </span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => void deleteCommentThread(comment.id)}
                    disabled={busy}
                    className="h-7 px-2 rounded-md border border-[var(--gb-border)] text-[11px] text-[var(--gb-text-muted)] hover:bg-[var(--gb-hover)] disabled:opacity-40"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void setCommentStatus(
                        comment.id,
                        comment.status === 'open' ? 'resolved' : 'open',
                      )
                    }
                    disabled={busy}
                    className="h-7 px-2 rounded-md border border-[var(--gb-border)] text-[11px] text-[var(--gb-text)] hover:bg-[var(--gb-hover)] disabled:opacity-40"
                  >
                    {comment.status === 'open' ? 'Resolve' : 'Reopen'}
                  </button>
                </div>
              </div>
            </article>
          ))}

        {activeTab === 'suggestions' &&
          suggestions.map((suggestion) => (
            <article
              key={suggestion.id}
              className="rounded-md border border-[var(--gb-border)] bg-[var(--gb-bg)] p-3"
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-[12px] font-medium text-[var(--gb-text)] truncate">
                  {authorName(suggestion.authorPrincipalId)}
                </span>
                <span className="text-[10px] uppercase text-[var(--gb-text-muted)]">
                  {suggestion.status}
                </span>
              </div>
              <p className="text-[12px] leading-5 text-[var(--gb-text)]">
                {suggestion.replacementText}
              </p>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-[11px] text-[var(--gb-text-muted)]">
                  {suggestion.range.start}-{suggestion.range.end}
                </span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => void decideSuggestion(suggestion.id, 'reject')}
                    disabled={busy || suggestion.status !== 'open'}
                    className="h-7 px-2 rounded-md border border-[var(--gb-border)] text-[11px] text-[var(--gb-text)] hover:bg-[var(--gb-hover)] disabled:opacity-40"
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    onClick={() => void decideSuggestion(suggestion.id, 'accept')}
                    disabled={busy || suggestion.status !== 'open'}
                    className="h-7 px-2 rounded-md bg-[var(--gb-accent)] text-white text-[11px] font-medium disabled:opacity-40"
                  >
                    Accept
                  </button>
                </div>
              </div>
            </article>
          ))}

        {activeTab === 'versions' && (
          <>
            {fileId && baseVersionId && (
              <button
                type="button"
                onClick={() => void saveVersion()}
                disabled={busy}
                className="w-full h-8 rounded-md border border-[var(--gb-border)] text-[11px] text-[var(--gb-text)] hover:bg-[var(--gb-hover)] disabled:opacity-40"
              >
                {busy ? 'Saving…' : 'Save version'}
              </button>
            )}
            {sortedVersions.map((version) => (
              <article
                key={version.versionId}
                className="rounded-md border border-[var(--gb-border)] bg-[var(--gb-bg)] p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-medium text-[var(--gb-text)] truncate">
                    {version.label ?? `Version ${version.seq}`}
                  </span>
                  <span className="text-[11px] text-[var(--gb-text-muted)] flex-shrink-0">
                    {new Date(version.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-[var(--gb-text-muted)]">
                  {authorName(version.createdBy)} · seq {version.seq}
                </p>
              </article>
            ))}
          </>
        )}

        {activeTab === 'recovery' && (
          <>
            {recovery.length === 0 && (
              <p className="text-[11px] text-[var(--gb-text-muted)] opacity-60">
                No pending recovery records.
              </p>
            )}
            {recovery.map((record) => (
              <article
                key={record.recordId}
                className="rounded-md border border-[var(--gb-border)] bg-[var(--gb-bg)] p-3"
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-[11px] font-medium text-red-400">{record.reason}</span>
                  <span className="text-[10px] text-[var(--gb-text-muted)] flex-shrink-0">
                    {new Date(record.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="text-[11px] font-mono text-[var(--gb-text-muted)] truncate">
                  {record.observedPath ?? record.fileId ?? '—'}
                </p>
                <details className="mt-1 text-[10px] text-[var(--gb-text-muted)]">
                  <summary className="cursor-pointer">payload</summary>
                  <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 p-2">
                    {record.payload}
                  </pre>
                </details>
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => void acknowledgeRecovery(record.recordId)}
                    disabled={busy}
                    className="h-7 px-2 rounded-md border border-[var(--gb-border)] text-[11px] text-[var(--gb-text)] hover:bg-[var(--gb-hover)] disabled:opacity-40"
                  >
                    Dismiss
                  </button>
                </div>
              </article>
            ))}
          </>
        )}
      </div>
    </aside>
  )
}

function clampRange(
  start: number,
  end: number,
  content: string,
): { start: number; end: number; stale: boolean } {
  const safeStart = Math.max(0, Math.min(start, content.length))
  const safeEnd = Math.max(safeStart, Math.min(end, content.length))
  return { start: safeStart, end: safeEnd, stale: false }
}
