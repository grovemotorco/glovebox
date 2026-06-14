export type WorkspaceRole = 'owner' | 'editor' | 'viewer'
export type DeviceTag = 'daemon' | 'browser'
export type VersionVector = Record<string, number>

export interface WorkspaceTreeEntry {
  fileId: string
  path: string
  contentKind?: 'markdown' | 'opaque'
  contentHash: string
  sizeBytes: number
  version: number
  versionVector?: VersionVector
  remoteRev?: number
  tombstone?: boolean
  seq?: number
  modifiedBy: string
  modifiedAt: number
}

export interface OpaqueChunkRef {
  hashB64: string
  size: number
}

export interface OpaqueManifest {
  chunks: OpaqueChunkRef[]
}

export type WorkspaceChangeEvent =
  | { type: 'snapshot'; entries: WorkspaceTreeEntry[]; seq?: number }
  | { type: 'create'; path: string; entry: WorkspaceTreeEntry; seq?: number }
  | { type: 'update'; path: string; entry: WorkspaceTreeEntry; seq?: number }
  | {
      type: 'delete'
      path: string
      fileId: string
      seq?: number
      versionVector?: VersionVector
      remoteRev?: number
      tombstone?: boolean
    }
  | { type: 'rename'; oldPath: string; newPath: string; entry: WorkspaceTreeEntry; seq?: number }
  /**
   * Per-file Loro content delta. Emitted alongside the tree-level `update`
   * event when a `content.update` op is accepted; carries the bytes that any
   * peer sharing the same baseline can apply directly to their LoroDoc.
   *
   * Binary payloads are base64-encoded for the JSON-over-WebSocket transport.
   * The `originDeviceId` lets clients suppress echoes of their own updates.
   */
  | {
      type: 'content.loroUpdate'
      fileId: string
      loroUpdateB64: string
      contentVersionB64: string
      originDeviceId?: string
      seq?: number
    }
  | {
      type: 'content.opaqueUpdate'
      fileId: string
      hashHex: string
      sizeBytes: number
      manifest: OpaqueManifest
      originDeviceId?: string
      seq?: number
    }

export interface WorkspaceConfig {
  workspaceId: string
  serverUrl: string
  name: string
}

export interface MountEntry {
  id: string
  workspaceId: string
  path: string
  serverUrl: string
  createdAt: number
  lastSyncAt: number | null
}

export interface MountRegistry {
  mounts: MountEntry[]
}
