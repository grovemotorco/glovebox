import { useMemo, useState } from 'react'
import { useActions, useAppState } from '../data/store.ts'

type PanelTab = 'comments' | 'suggestions' | 'versions'

const tabs: { key: PanelTab; label: string }[] = [
  { key: 'comments', label: 'Comments' },
  { key: 'suggestions', label: 'Suggestions' },
  { key: 'versions', label: 'Versions' },
]

export function CollaborationPanel() {
  const { activeFileId, workspace, fileContents } = useAppState()
  const { createComment, setCommentStatus, createSuggestion, acceptSuggestion, rejectSuggestion } =
    useActions()
  const [activeTab, setActiveTab] = useState<PanelTab>('comments')
  const [commentBody, setCommentBody] = useState('')
  const [suggestionText, setSuggestionText] = useState('')
  const [rangeStart, setRangeStart] = useState(0)
  const [rangeEnd, setRangeEnd] = useState(24)

  const activeFile = activeFileId ? workspace.files.get(activeFileId) : null
  const activeContent = activeFileId ? (fileContents.get(activeFileId) ?? '') : ''
  const membersById = useMemo(
    () => new Map(workspace.members.map((member) => [member.id, member])),
    [workspace.members],
  )
  const comments = useMemo(
    () => workspace.comments.filter((comment) => comment.fileId === activeFileId),
    [activeFileId, workspace.comments],
  )
  const suggestions = useMemo(
    () => workspace.suggestions.filter((suggestion) => suggestion.fileId === activeFileId),
    [activeFileId, workspace.suggestions],
  )
  const versions = useMemo(
    () => workspace.versions.filter((version) => version.fileId === activeFileId),
    [activeFileId, workspace.versions],
  )

  const submitComment = () => {
    const body = commentBody.trim()
    if (!activeFileId || !body) return
    createComment({ fileId: activeFileId, body, start: rangeStart, end: rangeEnd })
    setCommentBody('')
  }

  const submitSuggestion = () => {
    const replacementText = suggestionText.trim()
    if (!activeFileId || !replacementText) return
    createSuggestion({ fileId: activeFileId, replacementText, start: rangeStart, end: rangeEnd })
    setSuggestionText('')
  }

  return (
    <aside className="w-80 flex-shrink-0 border-l border-[var(--gb-border)] bg-[var(--gb-sidebar-bg)] flex flex-col min-h-0">
      <header className="h-11 px-3 border-b border-[var(--gb-border)] flex items-center justify-between">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-[var(--gb-text)]">Review</h2>
          <p className="text-[11px] text-[var(--gb-text-muted)] truncate">
            {activeFile?.path ?? 'No file'}
          </p>
        </div>
      </header>

      <div className="grid grid-cols-3 border-b border-[var(--gb-border)]">
        {tabs.map((tab) => (
          <button
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

      <div className="p-3 border-b border-[var(--gb-border)]">
        <div className="grid grid-cols-2 gap-2 mb-2">
          <label className="text-[11px] text-[var(--gb-text-muted)]">
            Start
            <input
              value={rangeStart}
              min={0}
              max={activeContent.length}
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
              max={activeContent.length}
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
              className="min-w-0 flex-1 h-8 rounded-md bg-[var(--gb-bg)] border border-[var(--gb-border)] px-2 text-[12px] text-[var(--gb-text)] placeholder:text-[var(--gb-text-muted)]"
            />
            <button
              onClick={submitComment}
              disabled={!activeFileId || !commentBody.trim()}
              className="h-8 px-3 rounded-md bg-[var(--gb-accent)] text-white text-[12px] font-medium disabled:opacity-40"
            >
              Add
            </button>
          </div>
        ) : activeTab === 'suggestions' ? (
          <div className="flex gap-2">
            <input
              value={suggestionText}
              onChange={(event) => setSuggestionText(event.target.value)}
              placeholder="Replacement"
              className="min-w-0 flex-1 h-8 rounded-md bg-[var(--gb-bg)] border border-[var(--gb-border)] px-2 text-[12px] text-[var(--gb-text)] placeholder:text-[var(--gb-text-muted)]"
            />
            <button
              onClick={submitSuggestion}
              disabled={!activeFileId || !suggestionText.trim()}
              className="h-8 px-3 rounded-md bg-[var(--gb-accent)] text-white text-[12px] font-medium disabled:opacity-40"
            >
              Add
            </button>
          </div>
        ) : null}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
        {activeTab === 'comments' &&
          comments.map((comment) => (
            <article
              key={comment.id}
              className="rounded-md border border-[var(--gb-border)] bg-[var(--gb-bg)] p-3"
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-[12px] font-medium text-[var(--gb-text)]">
                  {membersById.get(comment.authorId)?.name ?? 'Unknown'}
                </span>
                <span className="text-[10px] uppercase text-[var(--gb-text-muted)]">
                  {comment.status}
                </span>
              </div>
              <p className="text-[12px] leading-5 text-[var(--gb-text)]">{comment.body}</p>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-[11px] text-[var(--gb-text-muted)]">
                  {comment.range.start}-{comment.range.end}
                </span>
                <button
                  onClick={() =>
                    setCommentStatus(comment.id, comment.status === 'open' ? 'resolved' : 'open')
                  }
                  className="h-7 px-2 rounded-md border border-[var(--gb-border)] text-[11px] text-[var(--gb-text)] hover:bg-[var(--gb-hover)]"
                >
                  {comment.status === 'open' ? 'Resolve' : 'Reopen'}
                </button>
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
                <span className="text-[12px] font-medium text-[var(--gb-text)]">
                  {membersById.get(suggestion.authorId)?.name ?? 'Unknown'}
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
                    onClick={() => rejectSuggestion(suggestion.id)}
                    disabled={suggestion.status !== 'open'}
                    className="h-7 px-2 rounded-md border border-[var(--gb-border)] text-[11px] text-[var(--gb-text)] hover:bg-[var(--gb-hover)] disabled:opacity-40"
                  >
                    Reject
                  </button>
                  <button
                    onClick={() => acceptSuggestion(suggestion.id)}
                    disabled={suggestion.status !== 'open'}
                    className="h-7 px-2 rounded-md bg-[var(--gb-accent)] text-white text-[11px] font-medium disabled:opacity-40"
                  >
                    Accept
                  </button>
                </div>
              </div>
            </article>
          ))}

        {activeTab === 'versions' &&
          versions.map((version) => (
            <article
              key={version.id}
              className="rounded-md border border-[var(--gb-border)] bg-[var(--gb-bg)] p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-medium text-[var(--gb-text)]">
                  {version.label}
                </span>
                <span className="text-[11px] text-[var(--gb-text-muted)]">
                  {new Date(version.createdAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-[var(--gb-text-muted)]">
                {membersById.get(version.authorId)?.name ?? 'Unknown'}
              </p>
            </article>
          ))}
      </div>
    </aside>
  )
}
