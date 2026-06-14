export interface FileStat {
  size: number
  mtimeMs: number
  isFile: boolean
  isDirectory: boolean
  isSymlink: boolean
  nodeId: string | null
}

export interface DirEntry {
  name: string
  type: 'file' | 'directory'
}

export interface ScanResult {
  relativePath: string
  absolutePath: string
  nodeId: string | null
}

export interface LocalFS {
  readonly mountDir: string

  readFile(relativePath: string): Promise<string>
  readFileBytes(relativePath: string): Promise<Uint8Array>
  stat(relativePath: string): Promise<FileStat | null>
  exists(relativePath: string): Promise<boolean>
  readdir(relativePath: string): Promise<DirEntry[]>

  writeFile(relativePath: string, content: string): Promise<string>
  writeFileBytes(relativePath: string, content: Uint8Array): Promise<string>
  deletePath(relativePath: string): Promise<void>
  mkdir(relativePath: string): Promise<void>
  /**
   * Atomic move (rename(2) under the hood): the node keeps its identity
   * (nodeId travels), an existing target is replaced, parents are created.
   * The daemon relocates a colliding local file with this single op so a
   * crash can never leave both the original and the copy (ISSUE-0050 B).
   */
  move(fromPath: string, toPath: string): Promise<void>

  hash(relativePath: string): Promise<string>
  scan(predicate: (name: string) => boolean): Promise<ScanResult[]>

  resolve(relativePath: string): string
  toRelative(absolutePath: string): string | null
}

type LocalFSErrorCode =
  | 'OUTSIDE_MOUNT'
  | 'SYMLINK_PARENT'
  | 'SYMLINK_TARGET'
  | 'INVALID_PATH'
  | 'NOT_FOUND'
  | 'NOT_A_FILE'
  | 'NOT_A_DIRECTORY'
  | 'IO_ERROR'

const ERROR_TEXT: Record<LocalFSErrorCode, string> = {
  OUTSIDE_MOUNT: 'path escapes the mount root',
  SYMLINK_PARENT: 'path traverses a symlinked directory',
  SYMLINK_TARGET: 'path points to a symlink',
  INVALID_PATH: 'path is not a valid workspace-relative path',
  NOT_FOUND: 'path does not exist',
  NOT_A_FILE: 'path is not a file',
  NOT_A_DIRECTORY: 'path is not a directory',
  IO_ERROR: 'filesystem operation failed',
}

export class LocalFSError extends Error {
  readonly code: LocalFSErrorCode
  readonly path: string

  constructor(code: LocalFSErrorCode, path: string, message?: string) {
    super(message ?? `LocalFS error for ${path}: ${ERROR_TEXT[code]}`)
    this.name = 'LocalFSError'
    this.code = code
    this.path = path
  }
}
