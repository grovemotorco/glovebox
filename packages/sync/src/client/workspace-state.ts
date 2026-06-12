import { LoroFileDoc } from '../loro/file-doc.ts'

/**
 * Browser V1 persistence (spec-browser-v1-client.md): exactly two artifacts
 * per workspace — a singleton WorkspaceState record and one snapshot record
 * per file. The snapshot record carries its own server-confirmed VV so
 * bytes+VV are always a consistent pair (one put is atomic); the copy in
 * FileState is a cache, never the authority (INV-6).
 */

export type ClientStoreName = 'state' | 'snapshots'

/**
 * Narrow async KV surface over IndexedDB. `IndexedDbClientStorage` is the
 * browser implementation; tests (and the M3 harness) use the in-memory one.
 */
export interface ClientStateStorage {
  get(store: ClientStoreName, key: string): Promise<unknown>
  put(store: ClientStoreName, key: string, value: unknown): Promise<void>
  delete(store: ClientStoreName, key: string): Promise<void>
  listKeys(store: ClientStoreName): Promise<string[]>
}

export interface FileState {
  path: string
  contentKind: 'markdown' | 'opaque'
  /** Cache of the snapshot record's VV — never reconciled FROM. */
  syncedVVB64: string
  lastKnownServerHash: string
  savedAt: number
}

export interface WorkspaceState {
  workspaceId: string
  deviceId: string
  /** Advanced by pull only, never by push. */
  lastAckedSeq: number
  files: Record<string, FileState>
}

export interface SnapshotRecord {
  fileId: string
  snapshot: Uint8Array
  /** Captured from the same doc state as `snapshot` — the authoritative pair. */
  syncedVVB64: string
  savedAt: number
}

export interface ReadyFile {
  fileId: string
  fileState: FileState
  snapshot: Uint8Array
  syncedVVB64: string
}

export interface ReconcileResult {
  state: WorkspaceState
  /** Files whose snapshot pair is intact and current — hydrate locally. */
  ready: ReadyFile[]
  /** Files needing a fresh `snapshot.get` (lost/corrupt snapshot write). */
  refetch: { fileId: string; fileState: FileState }[]
  /** True when the state record itself was missing/corrupt — full reset. */
  fresh: boolean
}

const STATE_KEY = 'workspace'

export interface WorkspaceStateStoreOptions {
  workspaceId: string
  deviceId: string
  now?: () => number
}

export class WorkspaceStateStore {
  readonly #storage: ClientStateStorage
  readonly #workspaceId: string
  readonly #deviceId: string
  readonly #now: () => number

  constructor(storage: ClientStateStorage, options: WorkspaceStateStoreOptions) {
    this.#storage = storage
    this.#workspaceId = options.workspaceId
    this.#deviceId = options.deviceId
    this.#now = options.now ?? (() => Date.now())
  }

  /**
   * Persist one file: snapshot record FIRST, then the state entry. A crash
   * between the writes leaves a newer snapshot than state — reconcile case
   * 1, harmless. The reverse order would fabricate case 2 on every crash.
   */
  async persistFile(
    fileId: string,
    pair: { snapshot: Uint8Array; syncedVVB64: string },
    meta: { path: string; contentKind: 'markdown' | 'opaque'; lastKnownServerHash: string },
  ): Promise<void> {
    const savedAt = this.#now()
    const record: SnapshotRecord = {
      fileId,
      snapshot: pair.snapshot,
      syncedVVB64: pair.syncedVVB64,
      savedAt,
    }
    await this.#storage.put('snapshots', fileId, record)

    const state = await this.#loadStateOrFresh()
    state.files[fileId] = {
      path: meta.path,
      contentKind: meta.contentKind,
      syncedVVB64: pair.syncedVVB64,
      lastKnownServerHash: meta.lastKnownServerHash,
      savedAt: this.#now(),
    }
    await this.#storage.put('state', STATE_KEY, state)
  }

  async setLastAckedSeq(seq: number): Promise<void> {
    const state = await this.#loadStateOrFresh()
    state.lastAckedSeq = seq
    await this.#storage.put('state', STATE_KEY, state)
  }

  async removeFile(fileId: string): Promise<void> {
    await this.#storage.delete('snapshots', fileId)
    const state = await this.#loadStateOrFresh()
    if (fileId in state.files) {
      delete state.files[fileId]
      await this.#storage.put('state', STATE_KEY, state)
    }
  }

  /** Startup reconcile per spec-browser-v1-client.md §write-ordering. */
  async load(): Promise<ReconcileResult> {
    const rawState = await this.#storage.get('state', STATE_KEY)
    const state = isWorkspaceState(rawState) ? rawState : null

    if (state === null) {
      // Full reset: drop any orphan snapshots so a later save can't pair
      // stale bytes with a fresh state record.
      for (const key of await this.#storage.listKeys('snapshots')) {
        await this.#storage.delete('snapshots', key)
      }
      return { state: this.#freshState(), ready: [], refetch: [], fresh: true }
    }

    const ready: ReadyFile[] = []
    const refetch: { fileId: string; fileState: FileState }[] = []

    for (const [fileId, fileState] of Object.entries(state.files)) {
      const raw = await this.#storage.get('snapshots', fileId)
      const record = isSnapshotRecord(raw) ? raw : null
      if (record === null || record.savedAt < fileState.savedAt || !importable(record.snapshot)) {
        // Cases 2 + 3: the snapshot write was lost or the record is
        // unprovable. The local doc would be behind lastAckedSeq, so this
        // file must hydrate fresh from the server; the cursor stays.
        refetch.push({ fileId, fileState })
        await this.#storage.delete('snapshots', fileId)
        continue
      }
      ready.push({ fileId, fileState, snapshot: record.snapshot, syncedVVB64: record.syncedVVB64 })
    }

    // Case 4: orphan snapshots with no state entry (first save crashed
    // between the two writes) are dropped, never guessed at.
    for (const key of await this.#storage.listKeys('snapshots')) {
      if (!(key in state.files)) {
        await this.#storage.delete('snapshots', key)
      }
    }

    return { state, ready, refetch, fresh: false }
  }

  async #loadStateOrFresh(): Promise<WorkspaceState> {
    const raw = await this.#storage.get('state', STATE_KEY)
    return isWorkspaceState(raw) ? raw : this.#freshState()
  }

  #freshState(): WorkspaceState {
    return {
      workspaceId: this.#workspaceId,
      deviceId: this.#deviceId,
      lastAckedSeq: 0,
      files: {},
    }
  }
}

function importable(snapshot: Uint8Array): boolean {
  try {
    LoroFileDoc.fromSnapshot(snapshot)
    return true
  } catch {
    return false
  }
}

function isWorkspaceState(value: unknown): value is WorkspaceState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as WorkspaceState
  return (
    typeof state.workspaceId === 'string' &&
    typeof state.deviceId === 'string' &&
    typeof state.lastAckedSeq === 'number' &&
    typeof state.files === 'object' &&
    state.files !== null
  )
}

function isSnapshotRecord(value: unknown): value is SnapshotRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as SnapshotRecord
  return (
    typeof record.fileId === 'string' &&
    record.snapshot instanceof Uint8Array &&
    typeof record.syncedVVB64 === 'string' &&
    typeof record.savedAt === 'number'
  )
}

/** In-memory implementation for tests and the M3 harness. */
export class MemoryClientStorage implements ClientStateStorage {
  readonly #stores = new Map<ClientStoreName, Map<string, unknown>>([
    ['state', new Map()],
    ['snapshots', new Map()],
  ])

  async get(store: ClientStoreName, key: string): Promise<unknown> {
    const value = this.#stores.get(store)!.get(key)
    return value === undefined ? undefined : structuredClone(value)
  }

  async put(store: ClientStoreName, key: string, value: unknown): Promise<void> {
    this.#stores.get(store)!.set(key, structuredClone(value))
  }

  async delete(store: ClientStoreName, key: string): Promise<void> {
    this.#stores.get(store)!.delete(key)
  }

  async listKeys(store: ClientStoreName): Promise<string[]> {
    return [...this.#stores.get(store)!.keys()]
  }
}

/** Browser implementation over IndexedDB. Not exercised in node tests. */
export class IndexedDbClientStorage implements ClientStateStorage {
  readonly #db: Promise<IDBDatabase>

  constructor(workspaceId: string) {
    this.#db = openDatabase(`glovebox.${workspaceId}`)
  }

  async get(store: ClientStoreName, key: string): Promise<unknown> {
    const db = await this.#db
    return requestToPromise(db.transaction(store, 'readonly').objectStore(store).get(key))
  }

  async put(store: ClientStoreName, key: string, value: unknown): Promise<void> {
    const db = await this.#db
    await requestToPromise(db.transaction(store, 'readwrite').objectStore(store).put(value, key))
  }

  async delete(store: ClientStoreName, key: string): Promise<void> {
    const db = await this.#db
    await requestToPromise(db.transaction(store, 'readwrite').objectStore(store).delete(key))
  }

  async listKeys(store: ClientStoreName): Promise<string[]> {
    const db = await this.#db
    const keys = await requestToPromise(
      db.transaction(store, 'readonly').objectStore(store).getAllKeys(),
    )
    return keys.filter((key): key is string => typeof key === 'string')
  }
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('state')) db.createObjectStore('state')
      if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
  })
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}
