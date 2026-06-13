import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { ReactNode } from 'react'
import type {
  InviteView,
  MemberView,
  RecoveryRecord,
  WorkspaceSummary,
  WorkspaceTreeEntry,
} from '@glovebox/api'
import { createBrowserUser, type AwarenessUser } from '@glovebox/core'
import { LoroFileDoc, LoroRoomClient } from '@glovebox/sync/loro'
import { WorkspacePresence, type WorkspacePresencePeer } from '@glovebox/sync/client'
import type { WorkspaceBatchWireOp } from '@glovebox/sync/server'
import { api, getOrCreateDeviceId } from '../lib/api.ts'
import {
  WorkspaceSocketTransport,
  type BatchSubmitResult,
  type ConnectionStatus,
} from '../lib/transport.ts'
import { applyTreeWireEvent, type TreeWireEvent } from '../lib/tree-events.ts'
import { baseName } from '../lib/tree.ts'

export interface SessionUser {
  id: string
  name: string
  email: string
}

export type WorkspaceConnectionStatus = 'connected' | 'syncing' | 'disconnected'

export interface RoomHandle {
  fileId: string
  path: string
  room: LoroRoomClient
  status: 'connecting' | 'ready' | 'error'
  error?: string
}

interface WorkspaceContextValue {
  user: SessionUser
  /** Mirrors workspace-bootstrap's humanPrincipalId — identifies "me" in member lists. */
  principalId: string
  deviceId: string

  workspaces: WorkspaceSummary[]
  workspacesLoaded: boolean
  workspace: WorkspaceSummary | null
  workspaceId: string | null
  selectWorkspace: (workspaceId: string) => void
  createWorkspace: (name: string) => Promise<WorkspaceSummary>
  refreshWorkspaces: () => Promise<void>

  tree: WorkspaceTreeEntry[]
  treeLoaded: boolean
  refreshTree: () => Promise<void>
  createFile: (path: string) => Promise<string>
  /** Submit structural tree ops (rename / delete) and refresh the tree. */
  submitTreeOps: (ops: WorkspaceBatchWireOp[]) => Promise<BatchSubmitResult>

  members: MemberView[]
  refreshMembers: () => Promise<void>
  invites: InviteView[]
  refreshInvites: () => Promise<void>

  recovery: RecoveryRecord[]
  refreshRecovery: () => Promise<void>

  connectionStatus: WorkspaceConnectionStatus
  peers: WorkspacePresencePeer[]
  openFile: (fileId: string, path: string) => void
  subscribeRooms: (listener: () => void) => () => void
  getRoomsSnapshot: () => ReadonlyMap<string, RoomHandle>
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

const ACTIVE_WORKSPACE_KEY = 'glovebox.activeWorkspace'
const TREE_POLL_INTERVAL_MS = 10_000

/**
 * Per-workspace data tagged with the workspace that produced it. Consumers
 * derive against the CURRENT selection, so a workspace switch can neither
 * flash the previous workspace's data nor be clobbered by a slow response
 * that arrives after the switch.
 */
interface KeyedData<T> {
  workspaceId: string
  value: T
}

interface TreeData extends KeyedData<WorkspaceTreeEntry[]> {
  seq: number
  loaded: boolean
}

const EMPTY_TREE: WorkspaceTreeEntry[] = []
const EMPTY_MEMBERS: MemberView[] = []
const EMPTY_INVITES: InviteView[] = []
const EMPTY_RECOVERY: RecoveryRecord[] = []

function humanPrincipalIdFor(userId: string): string {
  return `human_${userId.replaceAll(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'unknown'}`
}

function roomHasPendingChanges(handle: RoomHandle): boolean {
  if (handle.status !== 'ready') return false
  try {
    return handle.room.hasPendingChanges()
  } catch {
    return false
  }
}

/**
 * Owns everything tied to the signed-in user and the selected workspace:
 * workspace list, file tree, members/invites, recovery records, and the
 * live WebSocket connection (Loro rooms + presence).
 */
export function WorkspaceProvider({
  user,
  autoSync,
  children,
}: {
  user: SessionUser
  autoSync: boolean
  children: ReactNode
}) {
  const deviceId = useMemo(() => getOrCreateDeviceId(), [])
  const principalId = useMemo(() => humanPrincipalIdFor(user.id), [user.id])

  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [treeData, setTreeData] = useState<TreeData | null>(null)
  const [memberData, setMemberData] = useState<KeyedData<MemberView[]> | null>(null)
  const [inviteData, setInviteData] = useState<KeyedData<InviteView[]> | null>(null)
  const [recoveryData, setRecoveryData] = useState<KeyedData<RecoveryRecord[]> | null>(null)
  const [socketStatus, setSocketStatus] = useState<ConnectionStatus>('closed')
  const [peers, setPeers] = useState<WorkspacePresencePeer[]>([])

  const transportRef = useRef<WorkspaceSocketTransport | null>(null)
  const workspaceIdRef = useRef<string | null>(null)
  const treeDataRef = useRef<TreeData | null>(null)
  // One lazily-created mutable store for room state, so re-renders never
  // allocate throwaway Map/Set instances in initializers.
  const [roomStore] = useState(() => ({
    rooms: new Map<string, RoomHandle>(),
    snapshot: new Map<string, RoomHandle>() as ReadonlyMap<string, RoomHandle>,
    listeners: new Set<() => void>(),
  }))

  const emitRooms = useCallback(() => {
    roomStore.snapshot = new Map(roomStore.rooms)
    for (const fn of roomStore.listeners) fn()
  }, [roomStore])

  const commitTreeData = useCallback((next: TreeData) => {
    treeDataRef.current = next
    setTreeData(next)
  }, [])

  useEffect(() => {
    workspaceIdRef.current = workspaceId
  }, [workspaceId])

  const refreshWorkspaces = useCallback(async () => {
    const result = await api.workspaces.list()
    setWorkspaces(result.workspaces)
    setWorkspacesLoaded(true)
    setWorkspaceId((current) => {
      if (current && result.workspaces.some((ws) => ws.id === current)) return current
      const stored = localStorage.getItem(ACTIVE_WORKSPACE_KEY)
      const fallback =
        result.workspaces.find((ws) => ws.id === stored)?.id ?? result.workspaces[0]?.id ?? null
      return fallback
    })
  }, [])

  useEffect(() => {
    void refreshWorkspaces().catch(() => setWorkspacesLoaded(true))
  }, [refreshWorkspaces])

  const selectWorkspace = useCallback((id: string) => {
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, id)
    setWorkspaceId(id)
  }, [])

  const createWorkspace = useCallback(
    async (name: string) => {
      const created = await api.workspaces.create({ name })
      await refreshWorkspaces()
      selectWorkspace(created.id)
      return created
    },
    [refreshWorkspaces, selectWorkspace],
  )

  const refreshTree = useCallback(async () => {
    if (!workspaceId) return
    const result = await api.workspaces.tree({ workspaceId })
    if (workspaceIdRef.current !== workspaceId) return
    const current = treeDataRef.current
    if (current?.workspaceId === workspaceId && current.seq > result.seq) return
    commitTreeData({
      workspaceId,
      value: result.entries,
      seq: result.seq,
      loaded: true,
    })
  }, [commitTreeData, workspaceId])

  const refreshMembers = useCallback(async () => {
    if (!workspaceId) return
    const result = await api.members.list({ workspaceId })
    setMemberData({ workspaceId, value: result.members })
  }, [workspaceId])

  const refreshInvites = useCallback(async () => {
    if (!workspaceId) return
    const result = await api.invites.list({ workspaceId })
    setInviteData({ workspaceId, value: result.invites })
  }, [workspaceId])

  const refreshRecovery = useCallback(async () => {
    if (!workspaceId) return
    const result = await api.documents.recoveryList({ workspaceId })
    setRecoveryData({
      workspaceId,
      value: result.records.filter((record) => record.acknowledgedAt === null),
    })
  }, [workspaceId])

  const resurrectRoomFromPendingDelete = useCallback(
    async (handle: RoomHandle) => {
      const transport = transportRef.current
      if (!transport) return

      let localText: string
      try {
        localText = handle.room.getTextContent()
      } catch {
        return
      }

      transport.registerSnapshotSeed(handle.fileId, {
        observedPath: handle.path,
        initialContent: localText,
      })

      let snapshot: Uint8Array
      try {
        snapshot = await transport.fetchSnapshot(handle.fileId)
      } catch {
        return
      }

      const current = roomStore.rooms.get(handle.fileId)
      if (current?.room !== handle.room) return

      const doc = LoroFileDoc.fromSnapshot(snapshot)
      const room = new LoroRoomClient({
        fileId: handle.fileId,
        observedPath: handle.path,
        deviceId,
        transport,
        hydrate: { snapshot, syncedVersion: doc.contentVersion() },
      })
      handle.room.disconnect()
      const nextHandle: RoomHandle = {
        fileId: handle.fileId,
        path: handle.path,
        room,
        status: 'connecting',
      }
      roomStore.rooms.set(handle.fileId, nextHandle)
      emitRooms()

      try {
        await room.connect()
        const connected = roomStore.rooms.get(handle.fileId)
        if (connected?.room !== room) return
        if (room.getTextContent() !== localText) {
          await room.setTextContent(localText)
          await room.flush()
        }
        const latest = roomStore.rooms.get(handle.fileId)
        if (latest?.room !== room) return
        roomStore.rooms.set(handle.fileId, { ...latest, status: 'ready' })
        emitRooms()
        await refreshTree().catch(() => {})
      } catch (error: unknown) {
        const failed = roomStore.rooms.get(handle.fileId)
        if (failed?.room !== room) return
        roomStore.rooms.set(handle.fileId, {
          ...nextHandle,
          status: 'error',
          error: error instanceof Error ? error.message : 'failed to resurrect file',
        })
        emitRooms()
      }
    },
    [deviceId, emitRooms, refreshTree, roomStore],
  )

  const handleTreeEvent = useCallback(
    (event: TreeWireEvent) => {
      if (!workspaceId || workspaceIdRef.current !== workspaceId) return
      const current = treeDataRef.current
      if (!current || current.workspaceId !== workspaceId) {
        void refreshTree().catch(() => {})
        return
      }
      if (event.seq <= current.seq) return

      const hadGap = event.seq > current.seq + 1
      if (event.type === 'delete') {
        const handle = roomStore.rooms.get(event.fileId)
        if (handle && roomHasPendingChanges(handle)) {
          commitTreeData({ ...current, seq: event.seq })
          void resurrectRoomFromPendingDelete(handle).catch(() => {})
          return
        }
      }

      const nextTree = applyTreeWireEvent({ seq: current.seq, entries: current.value }, event)
      commitTreeData({ ...current, value: nextTree.entries, seq: nextTree.seq })

      let roomsChanged = false
      if (event.type === 'rename') {
        const handle = roomStore.rooms.get(event.fileId)
        if (handle && handle.path !== event.newPath) {
          roomStore.rooms.set(event.fileId, { ...handle, path: event.newPath })
          roomsChanged = true
        }
      } else if (event.type === 'delete') {
        const handle = roomStore.rooms.get(event.fileId)
        if (handle) {
          handle.room.disconnect()
          roomStore.rooms.delete(event.fileId)
          roomsChanged = true
        }
      }
      if (roomsChanged) emitRooms()
      if (hadGap) void refreshTree().catch(() => {})
    },
    [commitTreeData, emitRooms, refreshTree, resurrectRoomFromPendingDelete, roomStore, workspaceId],
  )

  // Load the basics on workspace switch. No reset needed: the keyed
  // derivations below ignore data from any other workspace.
  useEffect(() => {
    if (!workspaceId) return
    void refreshTree().catch(() => {})
    void refreshMembers().catch(() => {})
    void refreshInvites().catch(() => {})
    void refreshRecovery().catch(() => {})
  }, [workspaceId, refreshTree, refreshMembers, refreshInvites, refreshRecovery])

  const currentTreeData = treeData?.workspaceId === workspaceId ? treeData : null
  const tree = currentTreeData ? currentTreeData.value : EMPTY_TREE
  const treeLoaded = currentTreeData?.loaded ?? false
  const members = memberData?.workspaceId === workspaceId ? memberData.value : EMPTY_MEMBERS
  const invites = inviteData?.workspaceId === workspaceId ? inviteData.value : EMPTY_INVITES
  const recovery = recoveryData?.workspaceId === workspaceId ? recoveryData.value : EMPTY_RECOVERY

  // Tree broadcasts are the fast path; polling is the full-state backstop
  // for missed events and content-edit metadata.
  useEffect(() => {
    if (!workspaceId || !autoSync) return
    const timer = window.setInterval(() => {
      void refreshTree().catch(() => {})
    }, TREE_POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [workspaceId, autoSync, refreshTree])

  // Live connection: one socket per selected workspace, token re-minted on
  // every (re)connect. Dev mode (no WS_AUTH_SECRET) mints nothing and
  // connects anonymously.
  useEffect(() => {
    // No setters in this branch: socketStatus/peers start closed/empty and
    // the previous run's cleanup already restored them on teardown.
    if (!workspaceId || !autoSync) return

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const baseUrl = `${wsProtocol}//${window.location.host}/ws/${encodeURIComponent(workspaceId)}`
    const transport = new WorkspaceSocketTransport({
      deviceId,
      onStatus: setSocketStatus,
      getUrl: async () => {
        try {
          const minted = await api.auth.mintWorkspaceSocketToken({ workspaceId })
          // Null token = socket auth not configured (dev) — connect tokenless.
          return minted.token ? `${baseUrl}?token=${encodeURIComponent(minted.token)}` : baseUrl
        } catch {
          // Transient mint failure — try tokenless rather than not at all.
          return baseUrl
        }
      },
    })
    transportRef.current = transport

    const awarenessUser: AwarenessUser = createBrowserUser({
      id: principalId,
      name: user.name || user.email,
    })
    const presence = new WorkspacePresence({ transport })
    const unsubscribePresence = presence.subscribe(() => setPeers(presence.peers()))
    const unsubscribeTreeEvents = transport.subscribeTreeEvents(handleTreeEvent)
    let cancelled = false
    void presence
      .start()
      .then(() => {
        if (cancelled) return
        presence.setLocalState({ user: awarenessUser })
        setPeers(presence.peers())
      })
      .catch(() => {})

    return () => {
      cancelled = true
      unsubscribePresence()
      unsubscribeTreeEvents()
      presence.stop()
      for (const handle of roomStore.rooms.values()) {
        handle.room.disconnect()
      }
      roomStore.rooms.clear()
      emitRooms()
      transport.close()
      transportRef.current = null
      setPeers([])
      setSocketStatus('closed')
    }
  }, [
    workspaceId,
    autoSync,
    deviceId,
    principalId,
    user.name,
    user.email,
    roomStore,
    emitRooms,
    handleTreeEvent,
  ])

  const openFile = useCallback(
    (fileId: string, path: string) => {
      const transport = transportRef.current
      if (!transport || roomStore.rooms.has(fileId)) return

      const room = new LoroRoomClient({ fileId, observedPath: path, deviceId, transport })
      const handle: RoomHandle = { fileId, path, room, status: 'connecting' }
      roomStore.rooms.set(fileId, handle)
      emitRooms()

      void room
        .connect()
        .then(() => {
          const current = roomStore.rooms.get(fileId)
          if (current?.room !== room) return
          roomStore.rooms.set(fileId, { ...handle, status: 'ready' })
          emitRooms()
        })
        .catch((error: unknown) => {
          const current = roomStore.rooms.get(fileId)
          if (current?.room !== room) return
          roomStore.rooms.set(fileId, {
            ...handle,
            status: 'error',
            error: error instanceof Error ? error.message : 'failed to open file',
          })
          emitRooms()
        })
    },
    [deviceId, roomStore, emitRooms],
  )

  const createFile = useCallback(
    async (path: string): Promise<string> => {
      const transport = transportRef.current
      if (!transport) throw new Error('Not connected — enable auto-sync to create files')
      const fileId = `f_${crypto.randomUUID()}`
      transport.registerSnapshotSeed(fileId, {
        observedPath: path,
        initialContent: `# ${baseName(path).replace(/\.md$/i, '')}\n\n`,
      })
      openFile(fileId, path)
      const handle = roomStore.rooms.get(fileId)
      if (handle) await handle.room.connect()
      await refreshTree().catch(() => {})
      return fileId
    },
    [openFile, roomStore, refreshTree],
  )

  const submitTreeOps = useCallback(
    async (ops: WorkspaceBatchWireOp[]): Promise<BatchSubmitResult> => {
      const transport = transportRef.current
      if (!transport) throw new Error('Not connected — enable auto-sync to modify files')
      if (ops.length === 0) {
        return { type: 'ack', currentSeq: 0, acceptedOps: [], deferredOps: [] }
      }
      const result = await transport.submitBatch(ops)
      await refreshTree().catch(() => {})
      return result
    },
    [refreshTree],
  )

  const subscribeRooms = useCallback(
    (fn: () => void) => {
      roomStore.listeners.add(fn)
      return () => {
        roomStore.listeners.delete(fn)
      }
    },
    [roomStore],
  )

  const getRoomsSnapshot = useCallback(() => roomStore.snapshot, [roomStore])

  const connectionStatus: WorkspaceConnectionStatus = !autoSync
    ? 'disconnected'
    : socketStatus === 'open'
      ? 'connected'
      : socketStatus === 'connecting'
        ? 'syncing'
        : 'disconnected'

  const workspace = workspaces.find((ws) => ws.id === workspaceId) ?? null

  const value: WorkspaceContextValue = {
    user,
    principalId,
    deviceId,
    workspaces,
    workspacesLoaded,
    workspace,
    workspaceId,
    selectWorkspace,
    createWorkspace,
    refreshWorkspaces,
    tree,
    treeLoaded,
    refreshTree,
    createFile,
    submitTreeOps,
    members,
    refreshMembers,
    invites,
    refreshInvites,
    recovery,
    refreshRecovery,
    connectionStatus,
    peers,
    openFile,
    subscribeRooms,
    getRoomsSnapshot,
  }

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace(): WorkspaceContextValue {
  const context = use(WorkspaceContext)
  if (!context) throw new Error('useWorkspace must be used inside WorkspaceProvider')
  return context
}

/** Live map of room handles for files opened this session. */
function useRoomHandles(): ReadonlyMap<string, RoomHandle> {
  const { subscribeRooms, getRoomsSnapshot } = useWorkspace()
  return useSyncExternalStore(subscribeRooms, getRoomsSnapshot)
}

/** The room handle for a file, if one has been opened this session. */
export function useRoom(fileId: string | null): RoomHandle | null {
  const handles = useRoomHandles()
  return fileId ? (handles.get(fileId) ?? null) : null
}

/**
 * Subscribe to a ready room's changes. Local CM edits land in the Loro doc
 * without a room event until the server acks — the 1s poll keeps derived
 * state honest in that window (and when acks stall offline).
 */
function useRoomSubscribe(handle: RoomHandle | null) {
  return useCallback(
    (notify: () => void) => {
      if (!handle || handle.status !== 'ready') return () => {}
      const unsubscribe = handle.room.onChange(notify)
      const timer = window.setInterval(notify, 1000)
      return () => {
        unsubscribe()
        window.clearInterval(timer)
      }
    },
    [handle],
  )
}

/** Whether local edits still await a server ack. Version compare only. */
export function useRoomPending(handle: RoomHandle | null): boolean {
  const subscribe = useRoomSubscribe(handle)
  return useSyncExternalStore(subscribe, () =>
    handle?.status === 'ready' ? handle.room.hasPendingChanges() : false,
  )
}

/**
 * Live text of a room. Materializing the text is O(doc) — the snapshot is
 * cached against the doc's version vector so change events, polls, and
 * re-renders that didn't move the doc cost a cheap byte compare instead of
 * a full WASM string export. Mount only where the text is actually consumed
 * (e.g. the markdown preview), never on the editor hot path.
 */
export function useRoomContent(handle: RoomHandle | null): string {
  const subscribe = useRoomSubscribe(handle)
  const cache = useRef<{ room: LoroRoomClient; version: Uint8Array; text: string } | null>(null)
  const getSnapshot = useCallback(() => {
    if (!handle || handle.status !== 'ready') return ''
    try {
      const room = handle.room
      const version = room.getDoc().contentVersion()
      const cached = cache.current
      if (cached && cached.room === room && versionBytesEqual(cached.version, version)) {
        return cached.text
      }
      const text = room.getTextContent()
      cache.current = { room, version, text }
      return text
    } catch {
      // Reads race room teardown (reconnect, workspace switch) — treat a
      // disconnected room as empty rather than crashing the view.
      return ''
    }
  }, [handle])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/**
 * One-shot text read for event handlers (comment/suggestion submits).
 * Disconnected rooms read as empty rather than throwing.
 */
export function readRoomText(handle: RoomHandle | null): string {
  if (!handle || handle.status !== 'ready') return ''
  try {
    return handle.room.getTextContent()
  } catch {
    return ''
  }
}

function versionBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false
  }
  return true
}
