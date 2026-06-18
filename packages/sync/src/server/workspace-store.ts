import {
  LIMITS,
  bumpVersionVector,
  compareVersionVectors,
  normalizeWorkspaceRelativePath,
  parseVersionVector,
  serializeVersionVector,
  versionVectorIncludes,
  type VersionVector,
  type WorkspaceChangeEvent,
  type WorkspaceTreeEntry,
} from '@glovebox.md/core'
import { sha256Hex } from './hash.ts'

const DEFAULT_WORKSPACE_MAX_FILES = 10_000
const DEFAULT_WORKSPACE_MAX_TOTAL_SIZE_BYTES = 500 * 1024 * 1024
const DEFAULT_WORKSPACE_MAX_CHANGE_EVENTS = 10_000

const encoder = new TextEncoder()

export class WorkspaceFileTooLargeError extends Error {
  readonly sizeBytes: number
  readonly limitBytes: number

  constructor(sizeBytes: number, limitBytes: number = LIMITS.maxMarkdownBytes) {
    super(`Workspace file exceeds size limit: ${sizeBytes} bytes > ${limitBytes} bytes`)
    this.name = 'WorkspaceFileTooLargeError'
    this.sizeBytes = sizeBytes
    this.limitBytes = limitBytes
  }
}

function assertFileSizeWithinLimit(sizeBytes: number): void {
  if (sizeBytes > LIMITS.maxMarkdownBytes) {
    throw new WorkspaceFileTooLargeError(sizeBytes)
  }
}

type WorkspaceSqlValue = ArrayBuffer | string | number | null

interface WorkspaceSqlCursorLike<T extends Record<string, WorkspaceSqlValue>> {
  toArray(): T[]
}

interface WorkspaceSqlExecutor {
  exec<T extends Record<string, WorkspaceSqlValue>>(
    query: string,
    ...bindings: unknown[]
  ): WorkspaceSqlCursorLike<T>
}

export interface WorkspaceSqlStorageLike {
  sql: WorkspaceSqlExecutor
  transactionSync<T>(closure: () => T): T
}

export interface WorkspaceStoreLimits {
  maxFiles?: number
  maxTotalSizeBytes?: number
  maxChangeEvents?: number
}

export interface WriteMeta {
  modifiedBy: string
}

export interface OpaqueContentMetadata {
  contentHash: string
  sizeBytes: number
}

export interface CreateResult {
  fileId: string
  created: boolean
  contentHash: string
  sizeBytes: number
  version: number
}

export interface CreateOrSuffixResult extends CreateResult {
  path: string
}

export interface WriteResult {
  fileId: string
  contentHash: string
  sizeBytes: number
  version: number
}

export interface RenameResult {
  fileId: string
  oldPath: string
  newPath: string
}

interface RenameTiebreakResult extends RenameResult {
  applied: boolean
}

interface DeleteResult {
  fileId: string
  path: string
  versionVector: VersionVector
  remoteRev: number
  seq: number
}

type DeleteTiebreakReason = 'deleted' | 'already-tombstoned' | 'remote-changed'

export interface DeleteTiebreakResult extends DeleteResult {
  deleted: boolean
  reason: DeleteTiebreakReason
  tombstone: boolean
}

export interface TombstoneContentResult {
  fileId: string
  path: string
  content: string
  versionVector: VersionVector
  remoteRev: number
  seq: number
  deletedAt: number
}

export interface WorkspaceTreeChangesResult {
  reset: boolean
  fromSeq: number
  currentSeq: number
  events: WorkspaceChangeEvent[]
}

export interface WorkspaceFileMetadata {
  id: string
  path: string
  contentHash: string | null
  sizeBytes: number
  version: number
  contentKind?: 'markdown' | 'opaque'
  createdAt: number
  updatedAt: number
}

interface WorkspaceRow extends Record<string, WorkspaceSqlValue> {
  file_id: string | null
  path: string
  parent_path: string
  name: string
  type: string
  content_kind: string | null
  content: string | null
  content_hash: string | null
  size_bytes: number
  version: number
  version_vector: string | null
  remote_rev: number | null
  seq: number | null
  modified_by: string | null
  modified_at: number
  created_at: number
}

interface CountRow extends Record<string, WorkspaceSqlValue> {
  count: number
}

interface WorkspaceUsageRow extends Record<string, WorkspaceSqlValue> {
  file_count: number
  total_size_bytes: number
}

interface WorkspaceMetaRow extends Record<string, WorkspaceSqlValue> {
  value: number
}

interface WorkspaceChangeRow extends Record<string, WorkspaceSqlValue> {
  seq: number
  type: string
  event_json: string
  created_at: number
}

interface WorkspaceTombstoneRow extends Record<string, WorkspaceSqlValue> {
  file_id: string
  path: string
  content_kind: string | null
  content: string | null
  content_hash: string
  size_bytes: number
  version: number
  version_vector: string | null
  remote_rev: number
  seq: number
  modified_by: string
  modified_at: number
  deleted_at: number
}

function requireWorkspaceFilePath(path: string): string {
  const normalized = normalizeWorkspaceRelativePath(path)
  if (!normalized) {
    throw new Error(`Invalid workspace path: ${path}`)
  }

  return normalized
}

function getParentPath(path: string): string {
  const lastSlash = path.lastIndexOf('/')
  return lastSlash === -1 ? '' : path.slice(0, lastSlash)
}

function getBaseName(path: string): string {
  const lastSlash = path.lastIndexOf('/')
  return lastSlash === -1 ? path : path.slice(lastSlash + 1)
}

export function getSuffixedPath(path: string, suffix: number): string {
  const parentPath = getParentPath(path)
  const name = getBaseName(path)
  const lower = name.toLowerCase()
  const lastDot = name.lastIndexOf('.')
  const extension = lower.endsWith('.markdown')
    ? '.markdown'
    : lower.endsWith('.md')
      ? '.md'
      : lastDot > 0
        ? name.slice(lastDot)
        : ''
  const stem = name.slice(0, name.length - extension.length)
  const suffixedName = `${stem}-${suffix}${name.slice(name.length - extension.length)}`
  return parentPath ? `${parentPath}/${suffixedName}` : suffixedName
}

function getContentSizeBytes(content: string): number {
  return encoder.encode(content).byteLength
}

function requireFileId(row: WorkspaceRow, context: string): string {
  if (row.file_id) {
    return row.file_id
  }

  throw new Error(`Missing file id for ${context}: ${row.path}`)
}

function requireFileContentHash(row: WorkspaceRow, context: string): string {
  if (typeof row.content_hash === 'string' && row.content_hash.length > 0) {
    return row.content_hash
  }

  throw new Error(`Missing content hash for ${context}: ${row.path}`)
}

function requireFileModifiedBy(row: WorkspaceRow, context: string): string {
  if (typeof row.modified_by === 'string' && row.modified_by.length > 0) {
    return row.modified_by
  }

  throw new Error(`Missing modified_by for ${context}: ${row.path}`)
}

function versionVectorFromRow(row: WorkspaceRow): VersionVector {
  const modifiedBy = requireFileModifiedBy(row, 'workspace version vector')
  return parseVersionVector(row.version_vector, { [modifiedBy]: row.version })
}

function contentKindFromRow(row: { content_kind?: string | null }): 'markdown' | 'opaque' {
  return row.content_kind === 'opaque' ? 'opaque' : 'markdown'
}

function toFileMetadata(row: WorkspaceRow): WorkspaceFileMetadata {
  return {
    id: row.file_id ?? '',
    path: row.path,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    version: row.version,
    ...(contentKindFromRow(row) === 'opaque' ? { contentKind: 'opaque' as const } : {}),
    createdAt: row.created_at,
    updatedAt: row.modified_at,
  }
}

function toTreeEntry(row: WorkspaceRow): WorkspaceTreeEntry {
  const modifiedBy = requireFileModifiedBy(row, 'workspace tree entry')
  const remoteRev = row.remote_rev ?? row.version
  return {
    fileId: requireFileId(row, 'workspace tree entry'),
    path: row.path,
    contentHash: requireFileContentHash(row, 'workspace tree entry'),
    sizeBytes: row.size_bytes,
    version: row.version,
    ...(contentKindFromRow(row) === 'opaque' ? { contentKind: 'opaque' as const } : {}),
    versionVector: parseVersionVector(row.version_vector, { [modifiedBy]: row.version }),
    remoteRev,
    tombstone: false,
    seq: row.seq ?? remoteRev,
    modifiedBy,
    modifiedAt: row.modified_at,
  }
}

function toTombstoneTreeEntry(row: WorkspaceTombstoneRow): WorkspaceTreeEntry {
  return {
    fileId: row.file_id,
    path: row.path,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    version: row.version,
    ...(contentKindFromRow(row) === 'opaque' ? { contentKind: 'opaque' as const } : {}),
    versionVector: parseVersionVector(row.version_vector, { [row.modified_by]: row.version }),
    remoteRev: row.remote_rev,
    tombstone: true,
    seq: row.seq,
    modifiedBy: row.modified_by,
    modifiedAt: row.modified_at,
  }
}

function toTombstoneContent(row: WorkspaceTombstoneRow): TombstoneContentResult {
  return {
    fileId: row.file_id,
    path: row.path,
    content: row.content ?? '',
    versionVector: parseVersionVector(row.version_vector, { [row.modified_by]: row.version }),
    remoteRev: row.remote_rev,
    seq: row.seq,
    deletedAt: row.deleted_at,
  }
}

function parseWorkspaceChange(raw: string): WorkspaceChangeEvent | null {
  try {
    return JSON.parse(raw) as WorkspaceChangeEvent
  } catch {
    return null
  }
}

export class WorkspaceStore {
  readonly #storage: WorkspaceSqlStorageLike
  readonly #limits: Required<WorkspaceStoreLimits>
  #initialized = false

  constructor(storage: WorkspaceSqlStorageLike, limits: WorkspaceStoreLimits = {}) {
    this.#storage = storage
    this.#limits = {
      maxFiles: DEFAULT_WORKSPACE_MAX_FILES,
      maxTotalSizeBytes: DEFAULT_WORKSPACE_MAX_TOTAL_SIZE_BYTES,
      maxChangeEvents: DEFAULT_WORKSPACE_MAX_CHANGE_EVENTS,
    }
    this.setLimits(limits)
  }

  setLimits(limits: WorkspaceStoreLimits = {}): void {
    this.#limits.maxFiles = limits.maxFiles ?? DEFAULT_WORKSPACE_MAX_FILES
    this.#limits.maxTotalSizeBytes =
      limits.maxTotalSizeBytes ?? DEFAULT_WORKSPACE_MAX_TOTAL_SIZE_BYTES
    this.#limits.maxChangeEvents = Math.max(
      1,
      Math.trunc(limits.maxChangeEvents ?? DEFAULT_WORKSPACE_MAX_CHANGE_EVENTS),
    )
  }

  ensureInitialized(): void {
    if (this.#initialized) {
      return
    }

    this.#storage.transactionSync(() => {
      this.#createWorkspaceFilesTable()
      this.#createWorkspaceTombstonesTable()
      this.#createWorkspaceChangesTable()
      this.#createWorkspaceMetaTable()
      this.#migrateWorkspaceFilesTable()
      this.#migrateWorkspaceTombstonesTable()
      this.#createWorkspaceFilesIndexes()
    })

    this.#initialized = true
  }

  createFile(
    path: string,
    content: string,
    meta: WriteMeta,
    providedFileId?: string,
  ): CreateResult {
    this.ensureInitialized()

    const normalizedPath = requireWorkspaceFilePath(path)
    const sizeBytes = getContentSizeBytes(content)
    assertFileSizeWithinLimit(sizeBytes)
    const contentHash = sha256Hex(content)
    const parentPath = getParentPath(normalizedPath)
    const name = getBaseName(normalizedPath)
    const now = Date.now()

    return this.#storage.transactionSync(() => {
      const existing = this.#getRowByPath(normalizedPath)
      if (existing) {
        if (existing.type !== 'file') {
          throw new Error(`Path already exists as a directory: ${normalizedPath}`)
        }

        return {
          fileId: requireFileId(existing, 'duplicate create'),
          created: false,
          contentHash: requireFileContentHash(existing, 'duplicate create'),
          sizeBytes: existing.size_bytes,
          version: existing.version,
        }
      }

      this.#ensureDirectoryChain(parentPath, meta.modifiedBy, now)
      this.#assertWorkspaceLimits({
        additionalFiles: 1,
        additionalSizeBytes: sizeBytes,
      })

      const fileId = providedFileId ?? crypto.randomUUID()
      const versionVector: VersionVector = { [meta.modifiedBy]: 1 }
      const seq = this.#nextSequence()
      this.#storage.sql.exec(`DELETE FROM workspace_tombstones WHERE file_id = ?`, fileId)
      this.#storage.sql.exec(
        `
          INSERT INTO workspace_files (
            file_id,
            path,
            parent_path,
            name,
            type,
            content,
            content_hash,
            size_bytes,
            version,
            version_vector,
            remote_rev,
            seq,
            modified_by,
            modified_at,
            created_at
          ) VALUES (?, ?, ?, ?, 'file', ?, ?, ?, 1, ?, 1, ?, ?, ?, ?)
        `,
        fileId,
        normalizedPath,
        parentPath,
        name,
        content,
        contentHash,
        sizeBytes,
        serializeVersionVector(versionVector),
        seq,
        meta.modifiedBy,
        now,
        now,
      )
      this.#recordEntryChange('create', fileId)

      return {
        fileId,
        created: true,
        contentHash,
        sizeBytes,
        version: 1,
      }
    })
  }

  createFileOrSuffix(path: string, content: string, meta: WriteMeta): CreateOrSuffixResult {
    this.ensureInitialized()

    const requestedPath = requireWorkspaceFilePath(path)
    const sizeBytes = getContentSizeBytes(content)
    assertFileSizeWithinLimit(sizeBytes)
    const contentHash = sha256Hex(content)
    const now = Date.now()

    return this.#storage.transactionSync(() => {
      let normalizedPath = requestedPath
      for (let suffix = 2; this.#getRowByPath(normalizedPath); suffix += 1) {
        normalizedPath = requireWorkspaceFilePath(getSuffixedPath(requestedPath, suffix))
      }

      const parentPath = getParentPath(normalizedPath)
      const name = getBaseName(normalizedPath)
      this.#ensureDirectoryChain(parentPath, meta.modifiedBy, now)
      this.#assertWorkspaceLimits({
        additionalFiles: 1,
        additionalSizeBytes: sizeBytes,
      })

      const fileId = crypto.randomUUID()
      const versionVector: VersionVector = { [meta.modifiedBy]: 1 }
      const seq = this.#nextSequence()
      this.#storage.sql.exec(`DELETE FROM workspace_tombstones WHERE file_id = ?`, fileId)
      this.#storage.sql.exec(
        `
          INSERT INTO workspace_files (
            file_id,
            path,
            parent_path,
            name,
            type,
            content,
            content_hash,
            size_bytes,
            version,
            version_vector,
            remote_rev,
            seq,
            modified_by,
            modified_at,
            created_at
          ) VALUES (?, ?, ?, ?, 'file', ?, ?, ?, 1, ?, 1, ?, ?, ?, ?)
        `,
        fileId,
        normalizedPath,
        parentPath,
        name,
        content,
        contentHash,
        sizeBytes,
        serializeVersionVector(versionVector),
        seq,
        meta.modifiedBy,
        now,
        now,
      )
      this.#recordEntryChange('create', fileId)

      return {
        fileId,
        path: normalizedPath,
        created: true,
        contentHash,
        sizeBytes,
        version: 1,
      }
    })
  }

  /**
   * Opaque twin of `createFile`: explicit fileId binding for the wire
   * surface (opaque.submit must bind the row to the submitter's fileId, not
   * mint a fresh one — idempotent replays would double-create otherwise).
   * Duplicate path returns the existing row, mirroring `createFile`.
   */
  createOpaqueFile(
    path: string,
    content: OpaqueContentMetadata,
    meta: WriteMeta,
    providedFileId?: string,
  ): CreateResult {
    this.ensureInitialized()

    const normalizedPath = requireWorkspaceFilePath(path)
    const sizeBytes = content.sizeBytes
    const contentHash = content.contentHash
    const parentPath = getParentPath(normalizedPath)
    const name = getBaseName(normalizedPath)
    const now = Date.now()

    return this.#storage.transactionSync(() => {
      const existing = this.#getRowByPath(normalizedPath)
      if (existing) {
        if (existing.type !== 'file') {
          throw new Error(`Path already exists as a directory: ${normalizedPath}`)
        }

        return {
          fileId: requireFileId(existing, 'duplicate create'),
          created: false,
          contentHash: requireFileContentHash(existing, 'duplicate create'),
          sizeBytes: existing.size_bytes,
          version: existing.version,
        }
      }

      this.#ensureDirectoryChain(parentPath, meta.modifiedBy, now)
      this.#assertWorkspaceLimits({
        additionalFiles: 1,
        additionalSizeBytes: sizeBytes,
      })

      const fileId = providedFileId ?? crypto.randomUUID()
      const versionVector: VersionVector = { [meta.modifiedBy]: 1 }
      const seq = this.#nextSequence()
      this.#storage.sql.exec(`DELETE FROM workspace_tombstones WHERE file_id = ?`, fileId)
      this.#storage.sql.exec(
        `
          INSERT INTO workspace_files (
            file_id,
            path,
            parent_path,
            name,
            type,
            content,
            content_hash,
            size_bytes,
            version,
            version_vector,
            remote_rev,
            seq,
            content_kind,
            modified_by,
            modified_at,
            created_at
          ) VALUES (?, ?, ?, ?, 'file', ?, ?, ?, 1, ?, 1, ?, 'opaque', ?, ?, ?)
        `,
        fileId,
        normalizedPath,
        parentPath,
        name,
        null,
        contentHash,
        sizeBytes,
        serializeVersionVector(versionVector),
        seq,
        meta.modifiedBy,
        now,
        now,
      )
      this.#recordEntryChange('create', fileId)

      return {
        fileId,
        created: true,
        contentHash,
        sizeBytes,
        version: 1,
      }
    })
  }

  /**
   * Re-derive a row's content kind after its path crossed the md→opaque
   * boundary. Opaque bytes live in DOFS, so the caller supplies the new
   * metadata after writing the UTF-8 bytes there. NO seq is allocated and
   * the version vector does not move: the rename that triggered the
   * transition is the one observable event.
   */
  transitionMarkdownToOpaque(fileId: string, content: OpaqueContentMetadata): boolean {
    this.ensureInitialized()

    return this.#storage.transactionSync(() => {
      const existing = this.#getFileRowById(fileId)
      if (!existing) return false
      if (contentKindFromRow(existing) === 'opaque') return false

      this.#storage.sql.exec(
        `
          UPDATE workspace_files
          SET content = ?, content_hash = ?, size_bytes = ?, content_kind = ?
          WHERE file_id = ?
        `,
        null,
        content.contentHash,
        content.sizeBytes,
        'opaque',
        requireFileId(existing, 'content kind transition'),
      )
      return true
    })
  }

  /**
   * Re-derive a row's content kind after its path crossed the opaque→md
   * boundary. The caller has already read/decode-validated DOFS bytes.
   * NO seq is allocated; the rename remains the observable change.
   */
  transitionOpaqueToMarkdown(fileId: string, text: string): boolean {
    this.ensureInitialized()

    const contentHash = sha256Hex(text)
    const sizeBytes = getContentSizeBytes(text)

    return this.#storage.transactionSync(() => {
      const existing = this.#getFileRowById(fileId)
      if (!existing) return false
      if (contentKindFromRow(existing) !== 'opaque') return false

      this.#storage.sql.exec(
        `
          UPDATE workspace_files
          SET content = ?, content_hash = ?, size_bytes = ?, content_kind = ?
          WHERE file_id = ?
        `,
        text,
        contentHash,
        sizeBytes,
        'markdown',
        requireFileId(existing, 'content kind transition'),
      )
      return true
    })
  }

  createOpaqueFileOrSuffix(
    path: string,
    content: OpaqueContentMetadata,
    meta: WriteMeta,
  ): CreateOrSuffixResult {
    this.ensureInitialized()

    const requestedPath = requireWorkspaceFilePath(path)
    const sizeBytes = content.sizeBytes
    const contentHash = content.contentHash
    const now = Date.now()

    return this.#storage.transactionSync(() => {
      let normalizedPath = requestedPath
      for (let suffix = 2; this.#getRowByPath(normalizedPath); suffix += 1) {
        normalizedPath = requireWorkspaceFilePath(getSuffixedPath(requestedPath, suffix))
      }

      const parentPath = getParentPath(normalizedPath)
      const name = getBaseName(normalizedPath)
      this.#ensureDirectoryChain(parentPath, meta.modifiedBy, now)
      this.#assertWorkspaceLimits({
        additionalFiles: 1,
        additionalSizeBytes: sizeBytes,
      })

      const fileId = crypto.randomUUID()
      const versionVector: VersionVector = { [meta.modifiedBy]: 1 }
      const seq = this.#nextSequence()
      this.#storage.sql.exec(`DELETE FROM workspace_tombstones WHERE file_id = ?`, fileId)
      this.#storage.sql.exec(
        `
          INSERT INTO workspace_files (
            file_id,
            path,
            parent_path,
            name,
            type,
            content,
            content_hash,
            size_bytes,
            version,
            version_vector,
            remote_rev,
            seq,
            content_kind,
            modified_by,
            modified_at,
            created_at
          ) VALUES (?, ?, ?, ?, 'file', ?, ?, ?, 1, ?, 1, ?, 'opaque', ?, ?, ?)
        `,
        fileId,
        normalizedPath,
        parentPath,
        name,
        null,
        contentHash,
        sizeBytes,
        serializeVersionVector(versionVector),
        seq,
        meta.modifiedBy,
        now,
        now,
      )
      this.#recordEntryChange('create', fileId)

      return {
        fileId,
        path: normalizedPath,
        created: true,
        contentHash,
        sizeBytes,
        version: 1,
      }
    })
  }

  deleteFile(path: string, meta: WriteMeta = { modifiedBy: 'server' }): DeleteResult | null {
    this.ensureInitialized()

    const normalizedPath = requireWorkspaceFilePath(path)
    return this.#storage.transactionSync(() => {
      const row = this.#getFileRowByPath(normalizedPath)
      if (!row) {
        return null
      }

      const remoteRev = (row.remote_rev ?? row.version) + 1
      const versionVector = bumpVersionVector(versionVectorFromRow(row), meta.modifiedBy)
      const seq = this.#nextSequence()
      const now = Date.now()
      const result = {
        fileId: requireFileId(row, 'file delete'),
        path: row.path,
        versionVector,
        remoteRev,
        seq,
      }
      this.#upsertTombstone(row, {
        modifiedBy: meta.modifiedBy,
        modifiedAt: now,
        remoteRev,
        seq,
        versionVector,
      })
      this.#storage.sql.exec(`DELETE FROM workspace_files WHERE path = ?`, normalizedPath)
      this.#pruneEmptyDirectories(row.parent_path)
      this.#recordDeleteChange(result)
      return result
    })
  }

  deleteFileById(fileId: string, meta: WriteMeta = { modifiedBy: 'server' }): DeleteResult | null {
    this.ensureInitialized()

    return this.#storage.transactionSync(() => {
      const row = this.#getFileRowById(fileId)
      if (!row) {
        return null
      }

      const remoteRev = (row.remote_rev ?? row.version) + 1
      const versionVector = bumpVersionVector(versionVectorFromRow(row), meta.modifiedBy)
      const seq = this.#nextSequence()
      const now = Date.now()
      const result = {
        fileId: requireFileId(row, 'file delete'),
        path: row.path,
        versionVector,
        remoteRev,
        seq,
      }
      this.#upsertTombstone(row, {
        modifiedBy: meta.modifiedBy,
        modifiedAt: now,
        remoteRev,
        seq,
        versionVector,
      })
      this.#storage.sql.exec(
        `DELETE FROM workspace_files WHERE file_id = ? AND type = 'file'`,
        fileId,
      )
      this.#pruneEmptyDirectories(row.parent_path)
      this.#recordDeleteChange(result)
      return result
    })
  }

  deleteFileByIdWithTiebreak(
    fileId: string,
    expectedVersionVector: VersionVector,
    meta: WriteMeta = { modifiedBy: 'server' },
  ): DeleteTiebreakResult | null {
    this.ensureInitialized()

    return this.#storage.transactionSync(() => {
      const row = this.#getFileRowById(fileId)
      if (!row) {
        const tombstone = this.#getTombstoneRowById(fileId)
        if (!tombstone) {
          return null
        }

        return {
          fileId: tombstone.file_id,
          path: tombstone.path,
          versionVector: parseVersionVector(tombstone.version_vector, {
            [tombstone.modified_by]: tombstone.remote_rev,
          }),
          remoteRev: tombstone.remote_rev,
          seq: tombstone.seq,
          deleted: true,
          reason: 'already-tombstoned',
          tombstone: true,
        }
      }

      const currentVector = versionVectorFromRow(row)
      if (!versionVectorIncludes(expectedVersionVector, currentVector)) {
        const remoteRev = row.remote_rev ?? row.version
        return {
          fileId: requireFileId(row, 'file delete tiebreak'),
          path: row.path,
          versionVector: currentVector,
          remoteRev,
          seq: row.seq ?? remoteRev,
          deleted: false,
          reason: 'remote-changed',
          tombstone: false,
        }
      }

      const remoteRev = (row.remote_rev ?? row.version) + 1
      const versionVector = bumpVersionVector(currentVector, meta.modifiedBy)
      const seq = this.#nextSequence()
      const now = Date.now()
      const result = {
        fileId: requireFileId(row, 'file delete tiebreak'),
        path: row.path,
        versionVector,
        remoteRev,
        seq,
        deleted: true,
        reason: 'deleted' as const,
        tombstone: true,
      }
      this.#upsertTombstone(row, {
        modifiedBy: meta.modifiedBy,
        modifiedAt: now,
        remoteRev,
        seq,
        versionVector,
      })
      this.#storage.sql.exec(
        `DELETE FROM workspace_files WHERE file_id = ? AND type = 'file'`,
        fileId,
      )
      this.#pruneEmptyDirectories(row.parent_path)
      this.#recordDeleteChange(result)
      return result
    })
  }

  renameFileById(fileId: string, newPath: string, meta: WriteMeta): RenameResult | null {
    this.ensureInitialized()

    const normalizedNewPath = requireWorkspaceFilePath(newPath)
    return this.#storage.transactionSync(() => {
      const existing = this.#getFileRowById(fileId)
      if (!existing) {
        return null
      }

      return this.#renameFileRow(existing, normalizedNewPath, meta)
    })
  }

  renameFileByIdWithTiebreak(
    fileId: string,
    newPath: string,
    meta: WriteMeta,
    expectedVersionVector?: VersionVector,
  ): RenameTiebreakResult | null {
    this.ensureInitialized()

    const normalizedNewPath = requireWorkspaceFilePath(newPath)
    return this.#storage.transactionSync(() => {
      const existing = this.#getFileRowById(fileId)
      if (!existing) {
        return null
      }

      const currentVector = versionVectorFromRow(existing)
      const relation = expectedVersionVector
        ? compareVersionVectors(expectedVersionVector, currentVector)
        : 'concurrent'
      const winningPath =
        relation === 'left-dominates' || relation === 'equal'
          ? normalizedNewPath
          : relation === 'right-dominates'
            ? existing.path
            : normalizedNewPath.localeCompare(existing.path) < 0
              ? normalizedNewPath
              : existing.path
      if (winningPath === existing.path) {
        return {
          fileId,
          oldPath: existing.path,
          newPath: existing.path,
          applied: false,
        }
      }

      const renamed = this.#renameFileRow(existing, winningPath, meta)
      return {
        ...renamed,
        applied: renamed.oldPath !== renamed.newPath,
      }
    })
  }

  readFileById(fileId: string): string | null {
    this.ensureInitialized()

    const row = this.#getFileRowById(fileId)
    return row?.content ?? null
  }

  readFileBytesById(fileId: string): Uint8Array | null {
    this.ensureInitialized()

    const row = this.#getFileRowById(fileId)
    if (!row) return null
    if (contentKindFromRow(row) === 'opaque') return null
    return new Uint8Array(Buffer.from(row.content ?? '', 'utf-8'))
  }

  readTombstoneContentById(fileId: string): TombstoneContentResult | null {
    this.ensureInitialized()

    const row = this.#getTombstoneRowById(fileId)
    return row ? toTombstoneContent(row) : null
  }

  writeFileById(fileId: string, content: string, meta: WriteMeta): WriteResult | null {
    this.ensureInitialized()

    const sizeBytes = getContentSizeBytes(content)
    assertFileSizeWithinLimit(sizeBytes)
    const contentHash = sha256Hex(content)
    const now = Date.now()

    return this.#storage.transactionSync(() => {
      const existing = this.#getFileRowById(fileId)
      if (!existing) {
        return null
      }

      this.#assertWorkspaceLimits({
        additionalFiles: 0,
        additionalSizeBytes: sizeBytes - existing.size_bytes,
      })
      const version = existing.version + 1
      const remoteRev = (existing.remote_rev ?? existing.version) + 1
      const versionVector = bumpVersionVector(versionVectorFromRow(existing), meta.modifiedBy)
      const seq = this.#nextSequence()
      this.#storage.sql.exec(
        `
          UPDATE workspace_files
          SET
            content = ?,
            content_hash = ?,
            size_bytes = ?,
            version = ?,
            version_vector = ?,
            remote_rev = ?,
            seq = ?,
            modified_by = ?,
            modified_at = ?
          WHERE path = ?
        `,
        content,
        contentHash,
        sizeBytes,
        version,
        serializeVersionVector(versionVector),
        remoteRev,
        seq,
        meta.modifiedBy,
        now,
        existing.path,
      )

      this.#recordEntryChange('update', requireFileId(existing, 'file write'))

      return {
        fileId: requireFileId(existing, 'file write'),
        contentHash,
        sizeBytes,
        version,
      }
    })
  }

  writeOpaqueMetadataById(
    fileId: string,
    content: OpaqueContentMetadata,
    meta: WriteMeta,
  ): WriteResult | null {
    this.ensureInitialized()

    const sizeBytes = content.sizeBytes
    const contentHash = content.contentHash
    const now = Date.now()

    return this.#storage.transactionSync(() => {
      const existing = this.#getFileRowById(fileId)
      if (!existing) {
        return null
      }

      this.#assertWorkspaceLimits({
        additionalFiles: 0,
        additionalSizeBytes: sizeBytes - existing.size_bytes,
      })
      const version = existing.version + 1
      const remoteRev = (existing.remote_rev ?? existing.version) + 1
      const versionVector = bumpVersionVector(versionVectorFromRow(existing), meta.modifiedBy)
      const seq = this.#nextSequence()
      this.#storage.sql.exec(
        `
          UPDATE workspace_files
          SET
            content = ?,
            content_hash = ?,
            size_bytes = ?,
            version = ?,
            version_vector = ?,
            remote_rev = ?,
            seq = ?,
            content_kind = 'opaque',
            modified_by = ?,
            modified_at = ?
          WHERE path = ?
        `,
        null,
        contentHash,
        sizeBytes,
        version,
        serializeVersionVector(versionVector),
        remoteRev,
        seq,
        meta.modifiedBy,
        now,
        existing.path,
      )

      this.#recordEntryChange('update', requireFileId(existing, 'opaque file write'))

      return {
        fileId: requireFileId(existing, 'opaque file write'),
        contentHash,
        sizeBytes,
        version,
      }
    })
  }

  getByFileId(fileId: string): WorkspaceFileMetadata | null {
    this.ensureInitialized()

    const row = this.#getFileRowById(fileId)
    return row ? toFileMetadata(row) : null
  }

  getTreeEntryByFileId(fileId: string): WorkspaceTreeEntry | null {
    this.ensureInitialized()

    const row = this.#getFileRowById(fileId)
    return row ? toTreeEntry(row) : null
  }

  getFileByPath(path: string): WorkspaceFileMetadata | null {
    this.ensureInitialized()

    const normalizedPath = requireWorkspaceFilePath(path)
    const row = this.#getFileRowByPath(normalizedPath)
    return row ? toFileMetadata(row) : null
  }

  listFileMetadata(): WorkspaceFileMetadata[] {
    this.ensureInitialized()

    return this.#storage.sql
      .exec<WorkspaceRow>(
        `
          SELECT
            file_id,
            path,
            parent_path,
            name,
            type,
            NULL AS content,
            content_kind,
            content_hash,
            size_bytes,
            version,
            version_vector,
            remote_rev,
            seq,
            modified_by,
            modified_at,
            created_at
          FROM workspace_files
          WHERE type = 'file'
          ORDER BY path ASC
        `,
      )
      .toArray()
      .map((row) => toFileMetadata(row))
  }

  listAll(): WorkspaceTreeEntry[] {
    this.ensureInitialized()

    const active = this.#storage.sql
      .exec<WorkspaceRow>(
        `
          SELECT
            file_id,
            path,
            parent_path,
            name,
            type,
            NULL AS content,
            content_kind,
            content_hash,
            size_bytes,
            version,
            version_vector,
            remote_rev,
            seq,
            modified_by,
            modified_at,
            created_at
          FROM workspace_files
          WHERE type = 'file'
          ORDER BY path ASC
        `,
      )
      .toArray()
      .map((row) => toTreeEntry(row))
    const tombstones = this.#storage.sql
      .exec<WorkspaceTombstoneRow>(
        `
          SELECT
            file_id,
            path,
            content,
            content_kind,
            content_hash,
            size_bytes,
            version,
            version_vector,
            remote_rev,
            seq,
            modified_by,
            modified_at,
            deleted_at
          FROM workspace_tombstones
          ORDER BY path ASC
        `,
      )
      .toArray()
      .map((row) => toTombstoneTreeEntry(row))

    return [...active, ...tombstones].sort((left, right) => left.path.localeCompare(right.path))
  }

  currentSequence(): number {
    this.ensureInitialized()
    return this.#currentSequence()
  }

  listChangesSince(afterSeq: number): WorkspaceTreeChangesResult {
    this.ensureInitialized()

    const fromSeq = Math.max(0, Math.trunc(afterSeq))
    const currentSeq = this.#currentSequence()
    const firstLoggedSeq =
      this.#storage.sql
        .exec<WorkspaceMetaRow>(`SELECT MIN(seq) AS value FROM workspace_store_changes`)
        .toArray()[0]?.value ?? null

    if (fromSeq >= currentSeq) {
      return {
        reset: false,
        fromSeq,
        currentSeq,
        events: [],
      }
    }

    if (firstLoggedSeq === null || fromSeq < firstLoggedSeq - 1) {
      return {
        reset: true,
        fromSeq,
        currentSeq,
        events: [
          {
            type: 'snapshot',
            entries: this.listAll(),
            seq: currentSeq,
          },
        ],
      }
    }

    const rows = this.#storage.sql
      .exec<WorkspaceChangeRow>(
        `
          SELECT
            seq,
            type,
            event_json,
            created_at
          FROM workspace_store_changes
          WHERE seq > ?
          ORDER BY seq ASC
        `,
        fromSeq,
      )
      .toArray()
    const events: WorkspaceChangeEvent[] = []
    let expectedSeq = fromSeq + 1
    let contiguous = true

    for (const row of rows) {
      if (row.seq !== expectedSeq) {
        contiguous = false
        break
      }

      const event = parseWorkspaceChange(row.event_json)
      if (!event) {
        contiguous = false
        break
      }

      events.push(event)
      expectedSeq += 1
    }

    if (!contiguous || expectedSeq - 1 !== currentSeq) {
      return {
        reset: true,
        fromSeq,
        currentSeq,
        events: [
          {
            type: 'snapshot',
            entries: this.listAll(),
            seq: currentSeq,
          },
        ],
      }
    }

    return {
      reset: false,
      fromSeq,
      currentSeq,
      events,
    }
  }

  #renameFileRow(existing: WorkspaceRow, normalizedNewPath: string, meta: WriteMeta): RenameResult {
    if (existing.path === normalizedNewPath) {
      return {
        fileId: requireFileId(existing, 'file rename'),
        oldPath: existing.path,
        newPath: normalizedNewPath,
      }
    }

    const target = this.#getRowByPath(normalizedNewPath)
    if (target) {
      throw new Error(`Path already exists: ${normalizedNewPath}`)
    }

    const nextParentPath = getParentPath(normalizedNewPath)
    const nextName = getBaseName(normalizedNewPath)
    const now = Date.now()
    const remoteRev = (existing.remote_rev ?? existing.version) + 1
    const versionVector = bumpVersionVector(versionVectorFromRow(existing), meta.modifiedBy)
    const seq = this.#nextSequence()

    this.#ensureDirectoryChain(nextParentPath, meta.modifiedBy, now)
    this.#storage.sql.exec(
      `
        UPDATE workspace_files
        SET
          path = ?,
          parent_path = ?,
          name = ?,
          version_vector = ?,
          remote_rev = ?,
          seq = ?,
          modified_by = ?,
          modified_at = ?
        WHERE file_id = ?
      `,
      normalizedNewPath,
      nextParentPath,
      nextName,
      serializeVersionVector(versionVector),
      remoteRev,
      seq,
      meta.modifiedBy,
      now,
      requireFileId(existing, 'file rename'),
    )
    this.#pruneEmptyDirectories(existing.parent_path)
    this.#recordRenameChange(requireFileId(existing, 'file rename'), existing.path)

    return {
      fileId: requireFileId(existing, 'file rename'),
      oldPath: existing.path,
      newPath: normalizedNewPath,
    }
  }

  #assertWorkspaceLimits(params: { additionalFiles: number; additionalSizeBytes: number }): void {
    if (params.additionalFiles <= 0 && params.additionalSizeBytes <= 0) {
      return
    }

    const usage = this.#getWorkspaceUsage()
    const nextFileCount = usage.fileCount + params.additionalFiles
    if (nextFileCount > this.#limits.maxFiles) {
      throw new Error(
        `Workspace file limit exceeded: ${nextFileCount} files would exceed ${this.#limits.maxFiles}`,
      )
    }

    const nextTotalSizeBytes = usage.totalSizeBytes + params.additionalSizeBytes
    if (nextTotalSizeBytes > this.#limits.maxTotalSizeBytes) {
      throw new Error(
        `Workspace size limit exceeded: ${nextTotalSizeBytes} bytes would exceed ${this.#limits.maxTotalSizeBytes}`,
      )
    }
  }

  #getWorkspaceUsage(): { fileCount: number; totalSizeBytes: number } {
    const row =
      this.#storage.sql
        .exec<WorkspaceUsageRow>(
          `
            SELECT
              COUNT(*) AS file_count,
              COALESCE(SUM(size_bytes), 0) AS total_size_bytes
            FROM workspace_files
            WHERE type = 'file'
          `,
        )
        .toArray()[0] ?? null

    return {
      fileCount: row?.file_count ?? 0,
      totalSizeBytes: row?.total_size_bytes ?? 0,
    }
  }

  #createWorkspaceFilesTable(): void {
    this.#storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS workspace_files (
        file_id TEXT,
        path TEXT PRIMARY KEY,
        parent_path TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('file', 'directory')),
        content_kind TEXT NOT NULL DEFAULT 'markdown',
        content TEXT,
        content_hash TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        version_vector TEXT,
        remote_rev INTEGER,
        seq INTEGER,
        modified_by TEXT,
        modified_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
  }

  #createWorkspaceTombstonesTable(): void {
    this.#storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS workspace_tombstones (
        file_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        content_kind TEXT NOT NULL DEFAULT 'markdown',
        content TEXT,
        content_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        version_vector TEXT,
        remote_rev INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        modified_by TEXT NOT NULL,
        modified_at INTEGER NOT NULL,
        deleted_at INTEGER NOT NULL
      )
    `)
  }

  #createWorkspaceChangesTable(): void {
    this.#storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS workspace_store_changes (
        seq INTEGER PRIMARY KEY,
        type TEXT NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
  }

  #createWorkspaceMetaTable(): void {
    this.#storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS workspace_meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      )
    `)
  }

  #migrateWorkspaceFilesTable(): void {
    for (const statement of [
      `ALTER TABLE workspace_files ADD COLUMN version_vector TEXT`,
      `ALTER TABLE workspace_files ADD COLUMN remote_rev INTEGER`,
      `ALTER TABLE workspace_files ADD COLUMN seq INTEGER`,
      `ALTER TABLE workspace_files ADD COLUMN content_kind TEXT DEFAULT 'markdown'`,
    ]) {
      try {
        this.#storage.sql.exec(statement)
      } catch {
        // SQLite lacks ADD COLUMN IF NOT EXISTS in the runtimes we target.
      }
    }
  }

  #migrateWorkspaceTombstonesTable(): void {
    try {
      this.#storage.sql.exec(`ALTER TABLE workspace_tombstones ADD COLUMN content TEXT`)
    } catch {
      // SQLite lacks ADD COLUMN IF NOT EXISTS in the runtimes we target.
    }
    try {
      this.#storage.sql.exec(
        `ALTER TABLE workspace_tombstones ADD COLUMN content_kind TEXT DEFAULT 'markdown'`,
      )
    } catch {
      // SQLite lacks ADD COLUMN IF NOT EXISTS in the runtimes we target.
    }
  }

  #createWorkspaceFilesIndexes(): void {
    this.#storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_workspace_files_parent_path
      ON workspace_files (parent_path)
    `)
    this.#storage.sql.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_files_file_id
      ON workspace_files (file_id)
    `)
    this.#storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_workspace_tombstones_path
      ON workspace_tombstones (path)
    `)
  }

  #upsertTombstone(
    row: WorkspaceRow,
    params: {
      modifiedBy: string
      modifiedAt: number
      remoteRev: number
      seq: number
      versionVector: VersionVector
    },
  ): void {
    this.#storage.sql.exec(
      `
        INSERT OR REPLACE INTO workspace_tombstones (
          file_id,
          path,
          content,
          content_kind,
          content_hash,
          size_bytes,
          version,
          version_vector,
          remote_rev,
          seq,
          modified_by,
          modified_at,
          deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      requireFileId(row, 'file tombstone'),
      row.path,
      contentKindFromRow(row) === 'opaque' ? null : (row.content ?? ''),
      contentKindFromRow(row),
      requireFileContentHash(row, 'file tombstone'),
      row.size_bytes,
      row.version,
      serializeVersionVector(params.versionVector),
      params.remoteRev,
      params.seq,
      params.modifiedBy,
      params.modifiedAt,
      params.modifiedAt,
    )
  }

  #nextSequence(): number {
    const current =
      this.#storage.sql
        .exec<WorkspaceMetaRow>(`SELECT value FROM workspace_meta WHERE key = 'seq' LIMIT 1`)
        .toArray()[0]?.value ?? 0
    const next = current + 1
    this.#storage.sql.exec(
      `INSERT OR REPLACE INTO workspace_meta (key, value) VALUES ('seq', ?)`,
      next,
    )
    return next
  }

  #currentSequence(): number {
    return (
      this.#storage.sql
        .exec<WorkspaceMetaRow>(`SELECT value FROM workspace_meta WHERE key = 'seq' LIMIT 1`)
        .toArray()[0]?.value ?? 0
    )
  }

  #recordWorkspaceChange(event: WorkspaceChangeEvent): void {
    const seq =
      event.seq ??
      ('entry' in event ? event.entry.seq : undefined) ??
      (event.type === 'delete' ? event.seq : undefined)
    if (!seq || !Number.isFinite(seq)) {
      return
    }

    this.#storage.sql.exec(
      `
        INSERT OR REPLACE INTO workspace_store_changes (
          seq,
          type,
          event_json,
          created_at
        ) VALUES (?, ?, ?, ?)
      `,
      seq,
      event.type,
      JSON.stringify(event),
      Date.now(),
    )
    this.#pruneWorkspaceChanges(seq)
  }

  #pruneWorkspaceChanges(currentSeq: number): void {
    const firstRetainedSeq = currentSeq - this.#limits.maxChangeEvents + 1
    if (firstRetainedSeq <= 1) {
      return
    }

    this.#storage.sql.exec(`DELETE FROM workspace_store_changes WHERE seq < ?`, firstRetainedSeq)
  }

  #recordEntryChange(type: 'create' | 'update', fileId: string): void {
    const entry = this.getTreeEntryByFileId(fileId)
    if (!entry) {
      return
    }

    this.#recordWorkspaceChange({
      type,
      path: entry.path,
      entry,
      seq: entry.seq,
    })
  }

  #recordRenameChange(fileId: string, oldPath: string): void {
    const entry = this.getTreeEntryByFileId(fileId)
    if (!entry) {
      return
    }

    this.#recordWorkspaceChange({
      type: 'rename',
      oldPath,
      newPath: entry.path,
      entry,
      seq: entry.seq,
    })
  }

  #recordDeleteChange(deleted: DeleteResult): void {
    this.#recordWorkspaceChange({
      type: 'delete',
      path: deleted.path,
      fileId: deleted.fileId,
      versionVector: deleted.versionVector,
      remoteRev: deleted.remoteRev,
      tombstone: true,
      seq: deleted.seq,
    })
  }

  #ensureDirectoryChain(parentPath: string, modifiedBy: string, now: number): void {
    if (!parentPath) {
      return
    }

    let currentPath = ''
    for (const segment of parentPath.split('/')) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment

      const existing = this.#getRowByPath(currentPath)
      if (existing) {
        if (existing.type !== 'directory') {
          throw new Error(`Path blocked by file: ${currentPath}`)
        }
        continue
      }

      this.#storage.sql.exec(
        `
          INSERT INTO workspace_files (
            file_id,
            path,
            parent_path,
            name,
            type,
            content,
            content_hash,
            size_bytes,
            version,
            modified_by,
            modified_at,
            created_at
          ) VALUES (NULL, ?, ?, ?, 'directory', NULL, NULL, 0, 1, ?, ?, ?)
        `,
        currentPath,
        getParentPath(currentPath),
        segment,
        modifiedBy,
        now,
        now,
      )
    }
  }

  #pruneEmptyDirectories(path: string): void {
    let currentPath = path

    while (currentPath) {
      const current = this.#getRowByPath(currentPath)
      if (!current || current.type !== 'directory') {
        return
      }

      const childCount = this.#storage.sql
        .exec<CountRow>(
          `SELECT COUNT(*) as count FROM workspace_files WHERE parent_path = ?`,
          currentPath,
        )
        .toArray()[0]?.count

      if ((childCount ?? 0) > 0) {
        return
      }

      this.#storage.sql.exec(
        `DELETE FROM workspace_files WHERE path = ? AND type = 'directory'`,
        currentPath,
      )
      currentPath = getParentPath(currentPath)
    }
  }

  #getRowByPath(path: string): WorkspaceRow | null {
    return (
      this.#storage.sql
        .exec<WorkspaceRow>(
          `
            SELECT
              file_id,
              path,
              parent_path,
              name,
              type,
              content,
              content_kind,
              content_hash,
              size_bytes,
              version,
              version_vector,
              remote_rev,
              seq,
              modified_by,
              modified_at,
              created_at
            FROM workspace_files
            WHERE path = ?
            LIMIT 1
          `,
          path,
        )
        .toArray()[0] ?? null
    )
  }

  #getFileRowByPath(path: string): WorkspaceRow | null {
    const row = this.#getRowByPath(path)
    return row?.type === 'file' ? row : null
  }

  #getFileRowById(fileId: string): WorkspaceRow | null {
    return (
      this.#storage.sql
        .exec<WorkspaceRow>(
          `
            SELECT
              file_id,
              path,
              parent_path,
              name,
              type,
              content,
              content_kind,
              content_hash,
              size_bytes,
              version,
              version_vector,
              remote_rev,
              seq,
              modified_by,
              modified_at,
              created_at
            FROM workspace_files
            WHERE file_id = ? AND type = 'file'
            LIMIT 1
          `,
          fileId,
        )
        .toArray()[0] ?? null
    )
  }

  #getTombstoneRowById(fileId: string): WorkspaceTombstoneRow | null {
    return (
      this.#storage.sql
        .exec<WorkspaceTombstoneRow>(
          `
            SELECT
              file_id,
              path,
              content,
              content_kind,
              content_hash,
              size_bytes,
              version,
              version_vector,
              remote_rev,
              seq,
              modified_by,
              modified_at,
              deleted_at
            FROM workspace_tombstones
            WHERE file_id = ?
            LIMIT 1
          `,
          fileId,
        )
        .toArray()[0] ?? null
    )
  }
}
