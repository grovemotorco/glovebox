import { useAppState, useActions } from '../data/store.ts'
import { isFolder } from '../data/mock.ts'
import type { TreeEntry } from '../data/mock.ts'

interface FileTreeProps {
  entries: TreeEntry[]
  depth: number
}

export function FileTree({ entries, depth }: FileTreeProps) {
  return (
    <ul className="list-none m-0 p-0">
      {entries.map((entry) =>
        isFolder(entry) ? (
          <FolderNode key={entry.id} entry={entry} depth={depth} />
        ) : (
          <FileNode key={entry.id} entry={entry} depth={depth} />
        ),
      )}
    </ul>
  )
}

function FolderNode({
  entry,
  depth,
}: {
  entry: TreeEntry & { children: TreeEntry[] }
  depth: number
}) {
  const { expandedFolders } = useAppState()
  const { toggleFolder } = useActions()
  const isOpen = expandedFolders.has(entry.id)

  return (
    <li>
      <button
        onClick={() => toggleFolder(entry.id)}
        className="flex items-center gap-1.5 w-full border-none bg-transparent text-[13px] font-semibold text-[var(--gb-text)] cursor-pointer rounded-md px-2 py-[5px] hover:bg-[var(--gb-hover)] text-left transition-colors"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <span
          className="w-3 flex-shrink-0 text-[10px] text-center text-[var(--gb-text-muted)] transition-transform duration-150"
          style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          ▶
        </span>
        <FolderIcon open={isOpen} />
        <span className="truncate">{entry.name}</span>
      </button>
      {isOpen && <FileTree entries={entry.children} depth={depth + 1} />}
    </li>
  )
}

function FileNode({ entry, depth }: { entry: TreeEntry; depth: number }) {
  const { activeFileId } = useAppState()
  const { setActiveFile } = useActions()
  const isActive = activeFileId === entry.id

  return (
    <li>
      <button
        onClick={() => setActiveFile(entry.id)}
        className={`flex items-center gap-1.5 w-full border-none bg-transparent text-[13px] cursor-pointer rounded-md px-2 py-[5px] text-left transition-colors ${
          isActive
            ? 'bg-[var(--gb-accent)] text-white font-medium'
            : 'text-[var(--gb-text)] hover:bg-[var(--gb-hover)]'
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <FileIcon name={entry.name} active={isActive} />
        <span className="truncate">{entry.name}</span>
      </button>
    </li>
  )
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
      {open ? (
        <path
          d="M1.5 3.5a1 1 0 011-1h3.586a1 1 0 01.707.293L8.5 4.5h5a1 1 0 011 1v1H2.22a1 1 0 00-.97.757l-1 4A1 1 0 001.22 12.5h11.56a1 1 0 00.97-.757L15 7.5v-2a1 1 0 00-1-1H8.5L6.793 2.793a1 1 0 00-.707-.293H2.5a1 1 0 00-1 1v2"
          stroke="#facc15"
          strokeWidth="1"
          fill="rgba(250,204,21,0.15)"
        />
      ) : (
        <path
          d="M2.5 12.5V3.5a1 1 0 011-1h3.086a1 1 0 01.707.293L8.5 4H13.5a1 1 0 011 1v7.5a1 1 0 01-1 1h-10a1 1 0 01-1-1z"
          stroke="#facc15"
          strokeWidth="1"
          fill="rgba(250,204,21,0.1)"
        />
      )}
    </svg>
  )
}

function FileIcon({ name, active }: { name: string; active: boolean }) {
  const ext = name.split('.').pop()
  const color = active ? 'white' : ext === 'md' ? '#3b82f6' : '#9ca3af'

  return (
    <span
      className="inline-flex items-center justify-center w-[18px] h-[18px] flex-shrink-0 text-[9px] font-bold rounded"
      style={{
        color,
        background: active ? 'rgba(255,255,255,0.2)' : `${color}1a`,
      }}
    >
      {ext === 'md' ? 'M' : ext?.toUpperCase().slice(0, 2)}
    </span>
  )
}
