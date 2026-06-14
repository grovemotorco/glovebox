// Types & interfaces
export type { SyncAuthorizer, VerifiedSyncConnection } from './types.ts'

// Filesystem utilities
export { sha256Hex } from './fs/hash.ts'
export {
  LocalFSError,
  type DirEntry,
  type FileStat,
  type LocalFS,
  type ScanResult,
} from './fs/local-fs.ts'
export { isMarkdownFile, isSyncableFile } from './fs/file-kind.ts'
export { normalizeEol } from './fs/eol.ts'
export { requireWorkspaceMarkdownPath, requireWorkspaceRelativePath } from './fs/workspace-path.ts'
export {
  OPAQUE_CHUNK_SIZE,
  assembleOpaqueWirePayload,
  buildOpaqueWirePayload,
  contentRefFromPayload,
  type OpaqueContentRef,
  type OpaqueObjectPayload,
  type OpaqueWirePayload,
} from './opaque-wire.ts'

// Loro primitives
export {
  TEXT_CONTAINER_ID,
  type LoroContentVersion,
  type LoroFileImportResult,
  type LoroFileMaterialized,
  type LoroFileState,
  type LoroFrontiers,
  type LoroSnapshot,
  type LoroUpdate,
} from './loro/types.ts'
export { LoroFileDoc, versionDominates, type LoroFileDocOptions } from './loro/file-doc.ts'
export {
  InMemoryLoroFileStore,
  LoroFileService,
  type CompactionPolicy,
  type LoroFileServiceOptions,
  type LoroFileStore,
} from './loro/file-store.ts'
export {
  LoroRoomClient,
  base64ToBytes,
  bytesToBase64,
  type LoroRoomChangeReason,
  type LoroRoomClientOptions,
  type LoroRoomTransport,
  type LoroUpdateWireEvent,
  type SubmitUpdateInput,
  type SubmitUpdateResult,
} from './loro/room-client.ts'
