import { normalizeWorkspaceRelativePath } from '@glovebox/core'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { sha256Hex } from '@glovebox/sync'
import {
  LocalFSError,
  type DirEntry,
  type FileStat,
  type LocalFS,
  type ScanResult,
} from '@glovebox/sync'

type MemNode = MemFile | MemDir

interface MemFile {
  kind: 'file'
  content: Uint8Array
  mtimeMs: number
  nodeId: string
}

interface MemDir {
  kind: 'dir'
  children: Map<string, MemNode>
  mtimeMs: number
}

export class MemoryFS implements LocalFS {
  readonly mountDir: string
  private root: MemDir
  private nextNodeId = 1

  constructor(mountDir = '/test/mount') {
    this.mountDir = mountDir
    this.root = this.createDir()
  }

  static from(files: Record<string, string>, mountDir?: string): MemoryFS {
    const fs = new MemoryFS(mountDir)
    for (const [path, content] of Object.entries(files)) {
      fs.putFile(path, content)
    }
    return fs
  }

  async readFile(relativePath: string): Promise<string> {
    const file = this.requireFile(relativePath)
    return Buffer.from(file.content).toString('utf-8')
  }

  async readFileBytes(relativePath: string): Promise<Uint8Array> {
    const file = this.requireFile(relativePath)
    return Uint8Array.from(file.content)
  }

  async stat(relativePath: string): Promise<FileStat | null> {
    const normalized = this.normalizePath(relativePath, { allowRoot: true })
    const node = normalized === '' ? this.root : this.lookup(normalized)
    if (!node) {
      return null
    }

    return this.toFileStat(node)
  }

  async exists(relativePath: string): Promise<boolean> {
    return (await this.stat(relativePath)) !== null
  }

  async readdir(relativePath: string): Promise<DirEntry[]> {
    const normalized = this.normalizePath(relativePath, { allowRoot: true })
    const node = normalized === '' ? this.root : this.lookup(normalized)
    if (!node || node.kind !== 'dir') {
      throw new LocalFSError('NOT_A_DIRECTORY', relativePath)
    }

    return Array.from(node.children.entries()).map(([name, child]) => ({
      name,
      type: child.kind === 'dir' ? 'directory' : 'file',
    }))
  }

  async writeFile(relativePath: string, content: string): Promise<string> {
    return this.writeFileBytes(relativePath, Buffer.from(content, 'utf-8'))
  }

  async writeFileBytes(relativePath: string, content: Uint8Array): Promise<string> {
    const normalized = this.normalizePath(relativePath)
    const parent = this.ensureParents(normalized)
    const name = this.basename(normalized)
    const existing = parent.children.get(name)
    if (existing?.kind === 'dir') {
      throw new LocalFSError('NOT_A_FILE', relativePath)
    }

    const now = Date.now()
    parent.children.set(name, {
      kind: 'file',
      content: Uint8Array.from(content),
      mtimeMs: now,
      nodeId: existing?.kind === 'file' ? existing.nodeId : this.allocNodeId(),
    })
    parent.mtimeMs = now
    return sha256Hex(content)
  }

  /**
   * True in-place write for simulated editors. In MemoryFS the regular
   * `writeFile` already overwrites in place (nodeId preserved), so this is
   * an alias — it exists so the editor-save corpus can express "the saver
   * kept the inode" explicitly, which NodeFS (whose `writeFile` is
   * atomic-replace) implements differently.
   */
  async writeInPlace(relativePath: string, content: string): Promise<string> {
    return this.writeFile(relativePath, content)
  }

  /**
   * POSIX rename(2) semantics for simulated editors (not part of LocalFS —
   * daemons never rename, editors do): the moved node keeps its identity
   * (nodeId travels with it), an existing target is replaced atomically.
   */
  async rename(fromPath: string, toPath: string): Promise<void> {
    const fromNormalized = this.normalizePath(fromPath)
    const from = this.locateParent(fromNormalized)
    if (!from || !from.node) {
      throw new LocalFSError('NOT_FOUND', fromPath)
    }
    const toNormalized = this.normalizePath(toPath)
    const toParent = this.ensureParents(toNormalized)
    const toName = this.basename(toNormalized)
    const existing = toParent.children.get(toName)
    if (existing?.kind === 'dir') {
      throw new LocalFSError('NOT_A_FILE', toPath)
    }

    from.parent.children.delete(from.name)
    toParent.children.set(toName, from.node)
    const now = Date.now()
    from.parent.mtimeMs = now
    toParent.mtimeMs = now
  }

  async deletePath(relativePath: string): Promise<void> {
    const normalized = this.normalizePath(relativePath)
    const target = this.locateParent(normalized)
    if (!target) {
      return
    }
    target.parent.children.delete(target.name)
    target.parent.mtimeMs = Date.now()
  }

  async mkdir(relativePath: string): Promise<void> {
    const normalized = this.normalizePath(relativePath, { allowRoot: true })
    if (normalized === '') {
      return
    }

    const parent = this.ensureParents(normalized)
    const name = this.basename(normalized)
    const existing = parent.children.get(name)
    if (!existing) {
      parent.children.set(name, this.createDir())
      parent.mtimeMs = Date.now()
      return
    }
    if (existing.kind !== 'dir') {
      throw new LocalFSError('NOT_A_DIRECTORY', relativePath)
    }
  }

  async hash(relativePath: string): Promise<string> {
    const content = await this.readFileBytes(relativePath)
    return sha256Hex(content)
  }

  async scan(predicate: (name: string) => boolean): Promise<ScanResult[]> {
    const results: ScanResult[] = []
    this.gather(this.root, '', predicate, results)
    return results
  }

  resolve(relativePath: string): string {
    const normalized = this.normalizePath(relativePath, { allowRoot: true })
    return normalized ? join(this.mountDir, ...normalized.split('/')) : this.mountDir
  }

  toRelative(absolutePath: string): string | null {
    const rel = relative(this.mountDir, resolve(absolutePath))
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      return null
    }

    return normalizeWorkspaceRelativePath(rel.split(sep).join('/'))
  }

  putFile(relativePath: string, content: string, mtimeMs = Date.now()): void {
    const normalized = this.normalizePath(relativePath)
    const parent = this.ensureParents(normalized)
    const name = this.basename(normalized)
    const existing = parent.children.get(name)
    if (existing?.kind === 'dir') {
      throw new LocalFSError('NOT_A_FILE', relativePath)
    }

    parent.children.set(name, {
      kind: 'file',
      content: Buffer.from(content, 'utf-8'),
      mtimeMs,
      nodeId: existing?.kind === 'file' ? existing.nodeId : this.allocNodeId(),
    })
    parent.mtimeMs = mtimeMs
  }

  getFile(relativePath: string): string | null {
    const node = this.lookup(this.normalizePath(relativePath))
    return node?.kind === 'file' ? Buffer.from(node.content).toString('utf-8') : null
  }

  getNodeId(relativePath: string): string | null {
    const node = this.lookup(this.normalizePath(relativePath))
    return node?.kind === 'file' ? node.nodeId : null
  }

  moveFile(from: string, to: string): void {
    const sourcePath = this.normalizePath(from)
    const source = this.locateParent(sourcePath)
    if (!source || source.node?.kind !== 'file') {
      throw new LocalFSError('NOT_FOUND', from)
    }

    const destinationPath = this.normalizePath(to)
    const destinationParent = this.ensureParents(destinationPath)
    const destinationName = this.basename(destinationPath)
    const existing = destinationParent.children.get(destinationName)
    if (existing?.kind === 'dir') {
      throw new LocalFSError('NOT_A_FILE', to)
    }

    source.parent.children.delete(source.name)
    destinationParent.children.set(destinationName, source.node)
    const now = Date.now()
    source.parent.mtimeMs = now
    destinationParent.mtimeMs = now
  }

  allPaths(): string[] {
    return Object.keys(this.snapshot()).sort()
  }

  snapshot(): Record<string, string> {
    const files: Record<string, string> = {}
    this.gatherSnapshot(this.root, '', files)
    return files
  }

  clear(): void {
    this.root = this.createDir()
    this.nextNodeId = 1
  }

  private normalizePath(relativePath: string, options: { allowRoot?: boolean } = {}): string {
    if (options.allowRoot && relativePath === '') {
      return ''
    }

    const normalized = normalizeWorkspaceRelativePath(relativePath)
    if (!normalized) {
      throw new LocalFSError('INVALID_PATH', relativePath)
    }

    return normalized
  }

  private lookup(normalizedPath: string): MemNode | null {
    const parts = normalizedPath.split('/')
    let current: MemNode = this.root

    for (let index = 0; index < parts.length; index += 1) {
      if (current.kind !== 'dir') {
        throw new LocalFSError('NOT_A_DIRECTORY', normalizedPath)
      }

      const child = current.children.get(parts[index]!)
      if (!child) {
        return null
      }
      current = child
    }

    return current
  }

  private locateParent(
    normalizedPath: string,
  ): { parent: MemDir; name: string; node: MemNode | null } | null {
    const parts = normalizedPath.split('/')
    let current = this.root

    for (let index = 0; index < parts.length - 1; index += 1) {
      const child = current.children.get(parts[index]!)
      if (!child) {
        return null
      }
      if (child.kind !== 'dir') {
        return null
      }
      current = child
    }

    const name = parts[parts.length - 1]!
    return {
      parent: current,
      name,
      node: current.children.get(name) ?? null,
    }
  }

  private ensureParents(normalizedPath: string): MemDir {
    const parts = normalizedPath.split('/')
    let current = this.root

    for (let index = 0; index < parts.length - 1; index += 1) {
      const segment = parts[index]!
      const child = current.children.get(segment)
      if (!child) {
        const dir = this.createDir()
        current.children.set(segment, dir)
        current = dir
        continue
      }
      if (child.kind !== 'dir') {
        throw new LocalFSError('NOT_A_DIRECTORY', normalizedPath)
      }
      current = child
    }

    return current
  }

  private requireFile(relativePath: string): MemFile {
    const node = this.lookup(this.normalizePath(relativePath))
    if (!node) {
      throw new LocalFSError('NOT_FOUND', relativePath)
    }
    if (node.kind !== 'file') {
      throw new LocalFSError('NOT_A_FILE', relativePath)
    }
    return node
  }

  private gather(
    dir: MemDir,
    prefix: string,
    predicate: (name: string) => boolean,
    out: ScanResult[],
  ): void {
    for (const [name, node] of dir.children) {
      const relativePath = prefix ? `${prefix}/${name}` : name
      if (node.kind === 'file' && predicate(name)) {
        out.push({
          relativePath,
          absolutePath: join(this.mountDir, ...relativePath.split('/')),
          nodeId: node.nodeId,
        })
      } else if (node.kind === 'dir') {
        this.gather(node, relativePath, predicate, out)
      }
    }
  }

  private gatherSnapshot(dir: MemDir, prefix: string, out: Record<string, string>): void {
    for (const [name, node] of dir.children) {
      const relativePath = prefix ? `${prefix}/${name}` : name
      if (node.kind === 'file') {
        out[relativePath] = Buffer.from(node.content).toString('utf-8')
      } else {
        this.gatherSnapshot(node, relativePath, out)
      }
    }
  }

  private toFileStat(node: MemNode): FileStat {
    return {
      size: node.kind === 'file' ? node.content.byteLength : 0,
      mtimeMs: node.mtimeMs,
      isFile: node.kind === 'file',
      isDirectory: node.kind === 'dir',
      isSymlink: false,
      nodeId: node.kind === 'file' ? node.nodeId : null,
    }
  }

  private allocNodeId(): string {
    return `0:${this.nextNodeId++}`
  }

  private basename(normalizedPath: string): string {
    const parts = normalizedPath.split('/')
    return parts[parts.length - 1]!
  }

  private createDir(): MemDir {
    return {
      kind: 'dir',
      children: new Map(),
      mtimeMs: Date.now(),
    }
  }
}
