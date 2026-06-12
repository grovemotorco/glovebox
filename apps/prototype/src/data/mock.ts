interface FileEntry {
  id: string
  name: string
  path: string
  content: string
  modified: string
}

interface FolderEntry {
  id: string
  name: string
  path: string
  children: TreeEntry[]
}

export type TreeEntry = FileEntry | FolderEntry

export function isFolder(entry: TreeEntry): entry is FolderEntry {
  return 'children' in entry
}

export interface Member {
  id: string
  name: string
  avatar: string
  status: 'online' | 'offline' | 'idle'
  role: 'owner' | 'editor' | 'viewer'
}

export interface DocumentVersion {
  id: string
  fileId: string
  label: string
  authorId: string
  createdAt: string
}

export interface CommentThread {
  id: string
  fileId: string
  body: string
  authorId: string
  status: 'open' | 'resolved'
  range: { start: number; end: number; stale?: boolean }
  createdAt: string
}

export interface Suggestion {
  id: string
  fileId: string
  replacementText: string
  authorId: string
  status: 'open' | 'accepted' | 'rejected'
  range: { start: number; end: number; stale?: boolean }
  baseVersionId: string
  createdAt: string
}

interface WorkspaceStats {
  totalFiles: number
  totalSize: string
  folders: number
  lastEdited: string
}

interface InviteConfig {
  shareLink: string
  inviteCode: string
  linkEnabled: boolean
  codeEnabled: boolean
  syncEnabled: boolean
}

export interface Workspace {
  id: string
  name: string
  status: 'connected' | 'disconnected' | 'syncing'
  lastSync: string
  deviceName: string
  tree: TreeEntry[]
  files: Map<string, FileEntry>
  members: Member[]
  versions: DocumentVersion[]
  comments: CommentThread[]
  suggestions: Suggestion[]
  stats: WorkspaceStats
  invite: InviteConfig
}

const readmeContent = `# Glovebox

A real-time file sync and collaborative markdown editing platform.

## Features

- **Real-time collaboration** — Multiple users can edit the same document simultaneously
- **File sync** — Automatically sync files across devices
- **Markdown-first** — Beautiful markdown editing and rendering
- **Workspaces** — Organize files into workspaces

## Getting Started

Install the CLI to get started:

\`\`\`bash
npm install -g @glovebox/cli
glovebox init my-workspace
\`\`\`

Then open the web editor at \`https://app.glovebox.dev\`.

## Architecture

The system uses **CRDTs** (Conflict-free Replicated Data Types) via Yjs to handle real-time collaboration without conflicts.

> "The best sync is the one you don't notice." — Someone wise

### Components

1. **Web App** — TanStack Start + React
2. **CLI Daemon** — Node.js background sync
3. **Edge Workers** — Cloudflare Durable Objects
4. **Storage** — R2 + D1

---

*Built with love for writers and developers.*
`

const roadmapContent = `# Product Roadmap

## Q1 2026

- [x] Core editor MVP
- [x] Real-time collaboration via CRDT
- [x] Basic file tree navigation
- [ ] Workspace sharing & permissions

## Q2 2026

- [ ] Mobile-responsive editor
- [ ] Offline mode with background sync
- [ ] Plugin system for custom renderers
- [ ] Version history with diff view

## Q3 2026

- [ ] End-to-end encryption
- [ ] Self-hosted deployment option
- [ ] API for third-party integrations

## Notes

Priority is stability and performance before new features. We want the core editing experience to feel **rock solid** before expanding.
`

const designSystemContent = `# Design System

## Colors

Our palette is built around a dark-first approach:

| Token | Value | Usage |
|-------|-------|-------|
| \`--gb-bg\` | \`#0f1117\` | Page background |
| \`--gb-surface\` | \`#1a1b26\` | Cards, panels |
| \`--gb-border\` | \`#2d2f3a\` | Borders |
| \`--gb-accent\` | \`#3b82f6\` | Interactive elements |

## Typography

- **Sans**: Inter — UI text, headings
- **Mono**: JetBrains Mono — Code, editor

## Spacing

We use a 4px base grid. Common values:

- \`xs\`: 4px
- \`sm\`: 8px
- \`md\`: 16px
- \`lg\`: 24px
- \`xl\`: 32px
`

const apiDocsContent = `# API Reference

## Authentication

All API requests require a bearer token:

\`\`\`
Authorization: Bearer <token>
\`\`\`

## Endpoints

### GET /api/workspaces

Returns all workspaces for the authenticated user.

\`\`\`json
{
  "workspaces": [
    {
      "id": "ws_abc123",
      "name": "my-project",
      "fileCount": 42,
      "lastSync": "2026-04-09T10:30:00Z"
    }
  ]
}
\`\`\`

### POST /api/workspaces/:id/files

Upload a file to a workspace.

**Request body:**

\`\`\`json
{
  "path": "docs/readme.md",
  "content": "# Hello World"
}
\`\`\`

### WebSocket /ws/collaborate/:fileId

Real-time collaboration endpoint. Uses the Yjs protocol for CRDT sync.
`

const meetingNotesContent = `# Team Meeting — April 9, 2026

**Attendees:** Alice, Bob, Carol

## Updates

### Alice
- Shipped the new sidebar collapse animation
- Working on keyboard shortcut system

### Bob
- Fixed the WebSocket reconnection bug
- Started on file conflict resolution

### Carol
- Finished design mockups for mobile view
- Will start implementing responsive breakpoints

## Action Items

- [ ] Alice: Add Cmd+K command palette
- [ ] Bob: Write integration tests for sync
- [ ] Carol: Share responsive designs in Figma
- [ ] All: Review Q2 roadmap by Friday

## Decisions

- We'll ship the prototype to beta users next week
- Mobile support is a priority for Q2
`

const changelogContent = `# Changelog

## v0.4.0 — 2026-04-08

### Added
- Collapsible sidebar with smooth transitions
- File tree with folder expand/collapse
- Markdown preview with syntax highlighting

### Fixed
- Editor cursor jumping on remote updates
- Memory leak in WebSocket reconnection handler

### Changed
- Switched from Monaco to CodeMirror 6 for better performance
- Updated React to 19.2

## v0.3.0 — 2026-03-22

### Added
- Real-time collaboration via Yjs
- User presence indicators
- Basic file upload/download

### Fixed
- Unicode handling in file paths
`

const files: FileEntry[] = [
  {
    id: 'f1',
    name: 'README.md',
    path: '/README.md',
    content: readmeContent,
    modified: '2026-04-09T10:30:00Z',
  },
  {
    id: 'f2',
    name: 'roadmap.md',
    path: '/docs/roadmap.md',
    content: roadmapContent,
    modified: '2026-04-08T14:22:00Z',
  },
  {
    id: 'f3',
    name: 'design-system.md',
    path: '/docs/design-system.md',
    content: designSystemContent,
    modified: '2026-04-07T09:15:00Z',
  },
  {
    id: 'f4',
    name: 'api.md',
    path: '/docs/api.md',
    content: apiDocsContent,
    modified: '2026-04-06T16:00:00Z',
  },
  {
    id: 'f5',
    name: 'meeting-2026-04-09.md',
    path: '/notes/meeting-2026-04-09.md',
    content: meetingNotesContent,
    modified: '2026-04-09T11:00:00Z',
  },
  {
    id: 'f6',
    name: 'CHANGELOG.md',
    path: '/CHANGELOG.md',
    content: changelogContent,
    modified: '2026-04-08T18:45:00Z',
  },
]

const fileMap = new Map<string, FileEntry>()
for (const f of files) {
  fileMap.set(f.id, f)
}

const mockMembers: Member[] = [
  { id: 'm1', name: 'Alice Chen', avatar: 'AC', status: 'online', role: 'owner' },
  { id: 'm2', name: 'Bob Martinez', avatar: 'BM', status: 'online', role: 'editor' },
  { id: 'm3', name: 'Carol Kim', avatar: 'CK', status: 'idle', role: 'editor' },
  { id: 'm4', name: 'Dan Nguyen', avatar: 'DN', status: 'offline', role: 'viewer' },
]

const mockVersions: DocumentVersion[] = [
  {
    id: 'ver_readme_1',
    fileId: 'f1',
    label: 'Initial draft',
    authorId: 'm1',
    createdAt: '2026-04-09T09:30:00Z',
  },
  {
    id: 'ver_readme_2',
    fileId: 'f1',
    label: 'Architecture notes',
    authorId: 'm2',
    createdAt: '2026-04-09T10:30:00Z',
  },
  {
    id: 'ver_roadmap_1',
    fileId: 'f2',
    label: 'Roadmap import',
    authorId: 'm3',
    createdAt: '2026-04-08T14:22:00Z',
  },
]

const mockComments: CommentThread[] = [
  {
    id: 'com_readme_1',
    fileId: 'f1',
    body: 'Clarify the CLI install path before beta.',
    authorId: 'm2',
    status: 'open',
    range: { start: 140, end: 189 },
    createdAt: '2026-04-09T10:44:00Z',
  },
  {
    id: 'com_readme_2',
    fileId: 'f1',
    body: 'Resolved after the CRDT section was updated.',
    authorId: 'm3',
    status: 'resolved',
    range: { start: 520, end: 575 },
    createdAt: '2026-04-09T11:12:00Z',
  },
]

const mockSuggestions: Suggestion[] = [
  {
    id: 'sug_readme_1',
    fileId: 'f1',
    replacementText: 'Edge Workers coordinate authenticated workspace sessions.',
    authorId: 'm3',
    status: 'open',
    range: { start: 840, end: 878 },
    baseVersionId: 'ver_readme_2',
    createdAt: '2026-04-09T11:18:00Z',
  },
]

export const mockWorkspace: Workspace = {
  id: 'ws_proto_001',
  name: 'glovebox-docs',
  status: 'connected',
  lastSync: '2026-04-09T12:00:00Z',
  deviceName: 'MacBook Pro',
  tree: [
    files[0],
    files[5],
    {
      id: 'd1',
      name: 'docs',
      path: '/docs',
      children: [files[1], files[2], files[3]],
    },
    {
      id: 'd2',
      name: 'notes',
      path: '/notes',
      children: [files[4]],
    },
  ],
  files: fileMap,
  members: mockMembers,
  versions: mockVersions,
  comments: mockComments,
  suggestions: mockSuggestions,
  stats: {
    totalFiles: 6,
    totalSize: '24.8 KB',
    folders: 2,
    lastEdited: '2026-04-09T11:00:00Z',
  },
  invite: {
    shareLink: 'https://app.glovebox.dev/join/ws_proto_001',
    inviteCode: 'GBX-7K4M-R2NP',
    linkEnabled: true,
    codeEnabled: true,
    syncEnabled: true,
  },
}
