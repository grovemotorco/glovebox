import { createHash } from 'node:crypto'
import { createWorkspaceError } from '../errors.js'
import { canonicalizePath } from '../path.js'
import { incrementRev } from '../rev.js'
import { ROOT_INODE } from '../schema/index.js'
import type { Database } from '../storage.js'
import { stageBlob } from '../sync/blobs.js'
import { buildManifest } from '../sync/manifests.js'
import { getBlobBytes } from './blobCache.js'
import { assertNotReadOnly } from './mount-guard.js'

// Fixed chunk size. Exported so tests can size inputs precisely
// without hard-coding the magic number twice.
export const CHUNK_SIZE = 512 * 1024

export type WriteFileContent = string | Uint8Array | ReadableStream<Uint8Array>

export interface WriteFileOptions {
  mode?: number
}

export interface WriteFileRange {
  start: number
  end: number
}

// Resolve directory-only paths (the parent of the target file). The
// final segment is handled by the caller. Returns the parent inode or
// throws ENOENT/ENOTDIR.
function resolveParent(db: Database, parts: string[], canonical: string): number {
  let parentInode = ROOT_INODE
  for (let i = 0; i < parts.length - 1; i++) {
    const name = parts[i]
    const child = db.one<{ child_inode: number }>(
      'SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?',
      parentInode,
      name,
    )
    if (child === undefined) {
      throw createWorkspaceError('ENOENT', `parent directory missing: ${canonical}`, canonical)
    }
    const next = db.one<{ inode: number; type: 'file' | 'dir' }>(
      'SELECT inode, type FROM vfs_nodes WHERE inode = ?',
      child.child_inode,
    )
    if (next === undefined) {
      throw createWorkspaceError('ENOENT', `dangling dirent: ${canonical}`, canonical)
    }
    if (next.type !== 'dir') {
      throw createWorkspaceError(
        'ENOTDIR',
        `parent path segment is not a directory: ${canonical}`,
        canonical,
      )
    }
    parentInode = next.inode
  }
  return parentInode
}

async function materialize(content: string | Uint8Array): Promise<Uint8Array> {
  if (typeof content === 'string') {
    return new TextEncoder().encode(content)
  }
  return content
}

// sha256 with a synchronous code path so writeFile can be called both
// from async drivers (the FS API) and from sync drivers (the
// VirtualProvider). node:crypto is available natively on Node and
// polyfilled by workerd.
function sha256(bytes: Uint8Array): Uint8Array {
  const hash = createHash('sha256')
  hash.update(bytes)
  return new Uint8Array(hash.digest())
}

interface PreparedChunk {
  hash: Uint8Array
  bytes: Uint8Array
  size: number
}

interface ChunkRef {
  hash: Uint8Array
  size: number
}

export function chunksOf(bytes: Uint8Array): PreparedChunk[] {
  const chunks: PreparedChunk[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, bytes.byteLength)
    // subarray (not slice) avoids an extra copy; sha256() takes its own
    // copy when needed.
    const slice = bytes.subarray(offset, end)
    const hash = sha256(slice)
    chunks.push({ hash, bytes: slice, size: slice.byteLength })
  }
  return chunks
}

export async function writeFile(
  db: Database,
  path: string,
  content: WriteFileContent,
  options: WriteFileOptions,
  now: () => number,
): Promise<void> {
  if (content instanceof ReadableStream) {
    await writeFileStreaming(db, path, content, options, now)
    return
  }
  const bytes = await materialize(content)
  writeFileSync(db, path, bytes, options, now)
}

// Streaming write path. Reads the source one source-chunk at a time,
// re-windows into fixed CHUNK_SIZE pieces, hashes each window, and
// stages it into vfs_blobs / vfs_blob_bytes as it goes. The final
// inode / dirent / vfs_chunks / manifest writes happen in a single
// short transaction once the source is drained, against a list of
// {hash, size} entries that's O(file_size / CHUNK_SIZE) bytes — not
// O(file_size).
//
// Failure mid-stream leaves blob rows behind; gc() reaps orphans on
// its next pass since no node references them.
async function writeFileStreaming(
  db: Database,
  path: string,
  source: ReadableStream<Uint8Array>,
  options: WriteFileOptions,
  now: () => number,
): Promise<void> {
  const { parts, path: canonical } = canonicalizePath(path)
  if (parts.length === 0) {
    throw createWorkspaceError('EISDIR', 'cannot write to the root directory', canonical)
  }
  // Reject before we stage any blob bytes so a read-only mount
  // doesn't grow orphan vfs_blobs rows that gc() then has to reap.
  assertNotReadOnly(db, canonical)
  const mode = (options.mode ?? 0o644) & 0o7777
  const mtime = now()

  const chunkRefs: Array<{ hash: Uint8Array; size: number }> = []
  // Carry-over buffer: bytes left over from the previous source chunk
  // that didn't fill a CHUNK_SIZE window.
  let carry: Uint8Array | undefined

  const flush = (chunk: Uint8Array): void => {
    const hash = sha256(chunk)
    stageBlob(db, hash, chunk, mtime)
    chunkRefs.push({ hash, size: chunk.byteLength })
  }

  const reader = source.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value === undefined || value.byteLength === 0) continue
      let input = value
      if (carry !== undefined) {
        // Splice carry-over onto the front of this source chunk so
        // we can re-window cleanly.
        const merged = new Uint8Array(carry.byteLength + input.byteLength)
        merged.set(carry, 0)
        merged.set(input, carry.byteLength)
        input = merged
        carry = undefined
      }
      let offset = 0
      while (input.byteLength - offset >= CHUNK_SIZE) {
        // Copy the window so the staged blob doesn't alias a
        // larger backing buffer.
        const window = input.slice(offset, offset + CHUNK_SIZE)
        flush(window)
        offset += CHUNK_SIZE
      }
      if (offset < input.byteLength) {
        carry = input.slice(offset)
      }
    }
  } finally {
    reader.releaseLock()
  }
  if (carry !== undefined && carry.byteLength > 0) {
    flush(carry)
  }

  // Wire up the inode against the staged blobs in one short
  // transaction. From this point on the SQL is the same shape as the
  // synchronous path — only the chunk-bytes step is skipped because
  // stageBlob already landed them above.
  db.transactionSync(() => {
    const parentInode = resolveParent(db, parts, canonical)
    const leafName = parts[parts.length - 1]
    const existing = db.one<{ child_inode: number }>(
      'SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?',
      parentInode,
      leafName,
    )
    let inode: number
    if (existing !== undefined) {
      const node = db.one<{ type: 'file' | 'dir' }>(
        'SELECT type FROM vfs_nodes WHERE inode = ?',
        existing.child_inode,
      )
      if (node?.type === 'dir') {
        throw createWorkspaceError('EISDIR', `path is a directory: ${canonical}`, canonical)
      }
      inode = existing.child_inode
      db.run('DELETE FROM vfs_chunks WHERE inode = ?', inode)
    } else {
      inode = insertFileNode(db, mode, mtime)
      db.run(
        'INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)',
        parentInode,
        leafName,
        inode,
      )
    }
    for (let idx = 0; idx < chunkRefs.length; idx++) {
      const ref = chunkRefs[idx]
      db.run(
        'INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)',
        inode,
        idx,
        ref.hash,
        ref.size,
      )
    }
    const manifestHash = buildManifest(db, chunkRefs, mtime)
    const rev = incrementRev(db)
    let totalSize = 0
    for (const ref of chunkRefs) totalSize += ref.size
    db.run(
      'UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ?, size = ?, manifest_hash = ? WHERE inode = ?',
      mode,
      mtime,
      rev,
      totalSize,
      manifestHash,
      inode,
    )
  })
}

// Allocate a fresh file inode row with the supplied mode and mtime,
// using SQLite's RETURNING so the new rowid comes back in the same
// statement instead of through a follow-up SELECT last_insert_rowid().
function insertFileNode(db: Database, mode: number, mtime: number): number {
  const row = db.one<{ inode: number }>(
    "INSERT INTO vfs_nodes (type, mode, mtime, rev) VALUES ('file', ?, ?, 0) RETURNING inode",
    mode,
    mtime,
  )
  if (row === undefined) {
    throw createWorkspaceError('EIO', 'failed to allocate inode')
  }
  return row.inode
}

function upsertChunkBlob(db: Database, chunk: PreparedChunk, lastSeen: number): void {
  db.run(
    'INSERT INTO vfs_blobs (hash, size, last_seen) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET last_seen = excluded.last_seen',
    chunk.hash,
    chunk.size,
    lastSeen,
  )
  db.run(
    'INSERT INTO vfs_blob_bytes (hash, bytes) VALUES (?, ?) ON CONFLICT(hash) DO NOTHING',
    chunk.hash,
    chunk.bytes,
  )
}

function replaceChunkRows(
  db: Database,
  inode: number,
  chunks: ChunkRef[],
  manifestTime: number,
): Uint8Array {
  db.run('DELETE FROM vfs_chunks WHERE inode = ?', inode)
  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx]
    db.run(
      'INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)',
      inode,
      idx,
      chunk.hash,
      chunk.size,
    )
  }
  return buildManifest(db, chunks, manifestTime)
}

function rangesOverlap(start: number, end: number, ranges: WriteFileRange[]): boolean {
  for (const range of ranges) {
    if (range.start < end && start < range.end) return true
  }
  return false
}

function normalizeRanges(ranges: WriteFileRange[], size: number): WriteFileRange[] {
  const normalized = ranges
    .map((range) => ({
      start: Math.max(0, Math.min(size, Math.floor(range.start))),
      end: Math.max(0, Math.min(size, Math.ceil(range.end))),
    }))
    .filter((range) => range.start < range.end)
    .sort((a, b) => a.start - b.start)

  const merged: WriteFileRange[] = []
  for (const range of normalized) {
    const previous = merged.at(-1)
    if (previous === undefined || previous.end < range.start) {
      merged.push({ ...range })
    } else {
      previous.end = Math.max(previous.end, range.end)
    }
  }
  return merged
}

function existingChunkRefs(db: Database, inode: number): ChunkRef[] {
  return db.all<ChunkRef>('SELECT hash, size FROM vfs_chunks WHERE inode = ? ORDER BY idx', inode)
}

function fileSizeForInode(db: Database, inode: number): number {
  return db.scalar<number>('SELECT size FROM vfs_nodes WHERE inode = ?', inode) ?? 0
}

function readChunkBytes(db: Database, inode: number, idx: number): Uint8Array {
  const chunk = db.one<{ hash: Uint8Array }>(
    'SELECT hash FROM vfs_chunks WHERE inode = ? AND idx = ?',
    inode,
    idx,
  )
  if (chunk === undefined) return new Uint8Array()
  const bytes = getBlobBytes(db, chunk.hash)
  if (bytes === undefined) {
    throw createWorkspaceError('EIO', 'missing blob bytes')
  }
  return bytes
}

function resolveFileInode(db: Database, path: string): { inode: number; mode: number } {
  const { path: canonical } = canonicalizePath(path)
  const node = db.one<{ inode: number; type: 'file' | 'dir'; mode: number }>(
    `SELECT n.inode AS inode, n.type AS type, n.mode AS mode
       FROM vfs_nodes n
      WHERE n.inode = (
        SELECT child_inode
          FROM vfs_dirents
         WHERE parent_inode = ? AND name = ?
      )`,
    ...parentAndNameForResolvedPath(db, path),
  )
  if (node === undefined) {
    throw createWorkspaceError('ENOENT', `no such file: ${canonical}`, canonical)
  }
  if (node.type !== 'file') {
    throw createWorkspaceError('EISDIR', `path is a directory: ${canonical}`, canonical)
  }
  return { inode: node.inode, mode: node.mode }
}

function parentAndNameForResolvedPath(db: Database, path: string): [number, string] {
  const { parts, path: canonical } = canonicalizePath(path)
  if (parts.length === 0) {
    throw createWorkspaceError('EISDIR', 'cannot write to the root directory', canonical)
  }
  return [resolveParent(db, parts, canonical), parts[parts.length - 1]]
}

// Update an inode's chunk-backed representation in place. Iterates over
// the full chunk grid but only touches `vfs_chunks` rows whose contents
// or size actually changed, so untouched chunk rows keep their
// rowids and the surrounding rows do not churn. The manifest is
// invalidated rather than recomputed; sync rebuilds it lazily.
function applyChunkedInodeUpdate(
  db: Database,
  inode: number,
  size: number,
  mode: number,
  mtime: number,
  isTouched: (idx: number, start: number, end: number) => boolean,
  buildChunkBytes: (idx: number, start: number, end: number, existing: Uint8Array) => Uint8Array,
): void {
  const oldChunks = existingChunkRefs(db, inode)
  const chunkCount = Math.ceil(size / CHUNK_SIZE)
  const oldChunkCount = oldChunks.length

  for (let idx = 0; idx < chunkCount; idx++) {
    const start = idx * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, size)
    const intendedSize = end - start
    const old = oldChunks[idx]
    const touched = isTouched(idx, start, end)
    // Stable chunk: existed before with the same logical size and the
    // caller did not flag it as touched. Skip without issuing SQL so
    // its rowid stays put.
    if (old !== undefined && old.size === intendedSize && !touched) continue

    const existingBytes = old !== undefined ? readChunkBytes(db, inode, idx) : new Uint8Array()
    const chunkBytes = buildChunkBytes(idx, start, end, existingBytes)
    if (chunkBytes.byteLength !== intendedSize) {
      throw createWorkspaceError('EIO', 'chunk builder returned wrong size')
    }
    const chunk = { hash: sha256(chunkBytes), bytes: chunkBytes, size: chunkBytes.byteLength }
    upsertChunkBlob(db, chunk, mtime)
    db.run(
      'INSERT OR REPLACE INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)',
      inode,
      idx,
      chunk.hash,
      chunk.size,
    )
  }

  // Drop any old chunks past the new end of file (shrink case).
  if (oldChunkCount > chunkCount) {
    db.run('DELETE FROM vfs_chunks WHERE inode = ? AND idx >= ?', inode, chunkCount)
  }

  const rev = incrementRev(db)
  db.run(
    'UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ?, size = ?, manifest_hash = NULL WHERE inode = ?',
    mode,
    mtime,
    rev,
    size,
    inode,
  )
}

export function createFileSync(
  db: Database,
  path: string,
  options: WriteFileOptions,
  now: () => number,
): void {
  const { path: canonical } = canonicalizePath(path)
  assertNotReadOnly(db, canonical)
  const [parentInode, leafName] = parentAndNameForResolvedPath(db, path)
  const mode = (options.mode ?? 0o644) & 0o7777
  const mtime = now()

  db.transactionSync(() => {
    const existing = db.one<{ child_inode: number }>(
      'SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?',
      parentInode,
      leafName,
    )
    if (existing !== undefined) {
      throw createWorkspaceError('EEXIST', `path exists: ${canonical}`, canonical)
    }
    const rev = incrementRev(db)
    // INSERT with RETURNING folds the last_insert_rowid lookup into
    // the same statement, and computing rev up front lets us write
    // the node row with its final stamp in one shot.
    const row = db.one<{ inode: number }>(
      "INSERT INTO vfs_nodes (type, mode, mtime, rev, manifest_hash) VALUES ('file', ?, ?, ?, NULL) RETURNING inode",
      mode,
      mtime,
      rev,
    )
    if (row === undefined) throw createWorkspaceError('EIO', 'failed to allocate inode')
    db.run(
      'INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)',
      parentInode,
      leafName,
      row.inode,
    )
  })
}

export function writeRangeSync(
  db: Database,
  path: string,
  bytes: Uint8Array,
  offset: number,
  options: WriteFileOptions,
  now: () => number,
): number {
  const { path: canonical } = canonicalizePath(path)
  assertNotReadOnly(db, canonical)
  if (!Number.isInteger(offset) || offset < 0) {
    throw createWorkspaceError('EINVAL', `invalid write offset: ${offset}`, canonical)
  }
  if (bytes.byteLength === 0) return 0
  const mtime = now()

  const { inode, mode: existingMode } = resolveFileInode(db, path)
  const mode = (options.mode ?? existingMode) & 0o7777

  db.transactionSync(() => {
    const oldSize = fileSizeForInode(db, inode)
    const writeEnd = offset + bytes.byteLength
    const nextSize = Math.max(oldSize, writeEnd)

    applyChunkedInodeUpdate(
      db,
      inode,
      nextSize,
      mode,
      mtime,
      (_idx, start, end) => offset < end && start < writeEnd,
      (_idx, start, end, existing) => {
        const chunkBytes = new Uint8Array(end - start)
        chunkBytes.set(existing.subarray(0, Math.min(existing.byteLength, chunkBytes.byteLength)))
        if (offset < end && start < writeEnd) {
          const copyStart = Math.max(start, offset)
          const copyEnd = Math.min(end, writeEnd)
          chunkBytes.set(bytes.subarray(copyStart - offset, copyEnd - offset), copyStart - start)
        }
        return chunkBytes
      },
    )
  })

  return bytes.byteLength
}

export function truncateFileSync(
  db: Database,
  path: string,
  size: number,
  now: () => number,
): void {
  const { path: canonical } = canonicalizePath(path)
  assertNotReadOnly(db, canonical)
  if (!Number.isInteger(size) || size < 0) {
    throw createWorkspaceError('EINVAL', `invalid truncate size: ${size}`, canonical)
  }
  const mtime = now()

  const { inode, mode } = resolveFileInode(db, path)

  db.transactionSync(() => {
    const oldSize = fileSizeForInode(db, inode)
    if (oldSize === size) return

    if (size === 0) {
      db.run('DELETE FROM vfs_chunks WHERE inode = ?', inode)
      const rev = incrementRev(db)
      db.run(
        'UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ?, size = 0, manifest_hash = NULL WHERE inode = ?',
        mode,
        mtime,
        rev,
        inode,
      )
      return
    }

    applyChunkedInodeUpdate(
      db,
      inode,
      size,
      mode,
      mtime,
      () => false,
      (_idx, start, end, existing) => {
        const chunkBytes = new Uint8Array(end - start)
        chunkBytes.set(existing.subarray(0, Math.min(existing.byteLength, chunkBytes.byteLength)))
        return chunkBytes
      },
    )
  })
}

// Synchronous entry point used by the VirtualProvider. Identical SQL
// to the async path; differs only in that the bytes have already been
// materialized.
export function writeFileSync(
  db: Database,
  path: string,
  bytes: Uint8Array,
  options: WriteFileOptions,
  now: () => number,
): void {
  const { parts, path: canonical } = canonicalizePath(path)
  if (parts.length === 0) {
    throw createWorkspaceError('EISDIR', 'cannot write to the root directory', canonical)
  }
  assertNotReadOnly(db, canonical)
  const mode = (options.mode ?? 0o644) & 0o7777
  const mtime = now()

  db.transactionSync(() => {
    const parentInode = resolveParent(db, parts, canonical)
    const leafName = parts[parts.length - 1]
    const existing = db.one<{ child_inode: number }>(
      'SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?',
      parentInode,
      leafName,
    )

    let inode: number
    if (existing !== undefined) {
      const node = db.one<{ type: 'file' | 'dir' }>(
        'SELECT type FROM vfs_nodes WHERE inode = ?',
        existing.child_inode,
      )
      if (node?.type === 'dir') {
        throw createWorkspaceError('EISDIR', `path is a directory: ${canonical}`, canonical)
      }
      inode = existing.child_inode
      // Replace the existing representation. Orphaned blobs (if any)
      // are cleaned up by a later gc() pass.
      db.run('DELETE FROM vfs_chunks WHERE inode = ?', inode)
    } else {
      inode = insertFileNode(db, mode, mtime)
      db.run(
        'INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)',
        parentInode,
        leafName,
        inode,
      )
    }

    const rev = incrementRev(db)
    const chunks = chunksOf(bytes)
    // Upsert blobs and write the new chunk list.
    for (let idx = 0; idx < chunks.length; idx++) {
      const chunk = chunks[idx]
      upsertChunkBlob(db, chunk, mtime)
      db.run(
        'INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)',
        inode,
        idx,
        chunk.hash,
        chunk.size,
      )
    }

    const manifestHash = buildManifest(db, chunks, mtime)
    db.run(
      'UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ?, size = ?, manifest_hash = ? WHERE inode = ?',
      mode,
      mtime,
      rev,
      bytes.byteLength,
      manifestHash,
      inode,
    )
  })
}

export function writeFileRangesSync(
  db: Database,
  path: string,
  bytes: Uint8Array,
  dirtyRanges: WriteFileRange[],
  options: WriteFileOptions,
  now: () => number,
): void {
  const { parts, path: canonical } = canonicalizePath(path)
  if (parts.length === 0) {
    throw createWorkspaceError('EISDIR', 'cannot write to the root directory', canonical)
  }
  assertNotReadOnly(db, canonical)
  const mode = (options.mode ?? 0o644) & 0o7777
  const ranges = normalizeRanges(dirtyRanges, bytes.byteLength)
  const mtime = now()
  db.transactionSync(() => {
    const parentInode = resolveParent(db, parts, canonical)
    const leafName = parts[parts.length - 1]
    const existing = db.one<{ child_inode: number }>(
      'SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?',
      parentInode,
      leafName,
    )

    let inode: number
    let oldChunks: ChunkRef[] = []
    if (existing !== undefined) {
      const node = db.one<{ type: 'file' | 'dir' }>(
        'SELECT type FROM vfs_nodes WHERE inode = ?',
        existing.child_inode,
      )
      if (node?.type === 'dir') {
        throw createWorkspaceError('EISDIR', `path is a directory: ${canonical}`, canonical)
      }
      inode = existing.child_inode
      oldChunks = existingChunkRefs(db, inode)
    } else {
      inode = insertFileNode(db, mode, mtime)
      db.run(
        'INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)',
        parentInode,
        leafName,
        inode,
      )
    }

    const rev = incrementRev(db)
    const nextChunks: ChunkRef[] = []
    const chunkCount = Math.ceil(bytes.byteLength / CHUNK_SIZE)
    for (let idx = 0; idx < chunkCount; idx++) {
      const start = idx * CHUNK_SIZE
      const end = Math.min(start + CHUNK_SIZE, bytes.byteLength)
      const size = end - start
      const oldChunk = oldChunks[idx]
      if (oldChunk !== undefined && oldChunk.size === size && !rangesOverlap(start, end, ranges)) {
        nextChunks.push(oldChunk)
        continue
      }
      const chunk = {
        hash: sha256(bytes.subarray(start, end)),
        bytes: bytes.subarray(start, end),
        size,
      }
      upsertChunkBlob(db, chunk, mtime)
      nextChunks.push({ hash: chunk.hash, size: chunk.size })
    }

    const manifestHash = replaceChunkRows(db, inode, nextChunks, mtime)
    db.run(
      'UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ?, size = ?, manifest_hash = ? WHERE inode = ?',
      mode,
      mtime,
      rev,
      bytes.byteLength,
      manifestHash,
      inode,
    )
  })
}
