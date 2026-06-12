import { readFile } from 'node:fs/promises'
import { sep } from 'node:path'
import { withDirMutex, writeFileSecure, type GloveboxPaths } from './paths.ts'

/**
 * `~/.glovebox/mounts.json` — the directory↔workspace binding registry
 * (M8 scope note §5). Entries are validated field-by-field on load
 * (loro-2 discipline: a corrupt or hand-edited file degrades to "entry
 * ignored", never a crash). Overlap refusal lives here because two mounts
 * over the same tree — nested or identical — would fight over watermarks
 * and sentinels.
 */

export interface MountEntry {
  mountId: string
  /** Canonical (realpath'd) absolute mount directory. */
  dir: string
  workspaceId: string
  serverUrl: string
  deviceId: string
  createdAt: number
}

export interface MountRegistry {
  version: 1
  mounts: MountEntry[]
}

const ENTRY_KEYS = new Set(['mountId', 'dir', 'workspaceId', 'serverUrl', 'deviceId', 'createdAt'])

function parseMountEntry(candidate: unknown): MountEntry | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null
  }
  const entry = candidate as Record<string, unknown>
  if (!Object.keys(entry).every((key) => ENTRY_KEYS.has(key))) {
    return null
  }
  if (
    typeof entry.mountId !== 'string' ||
    typeof entry.dir !== 'string' ||
    typeof entry.workspaceId !== 'string' ||
    typeof entry.serverUrl !== 'string' ||
    typeof entry.deviceId !== 'string' ||
    typeof entry.createdAt !== 'number' ||
    !Number.isFinite(entry.createdAt)
  ) {
    return null
  }
  return {
    mountId: entry.mountId,
    // Strip trailing separators (hand-edited files): "/a/" would be
    // refused by overlap detection yet invisible to every dir matcher.
    dir: entry.dir.length > 1 ? entry.dir.replace(/[/\\]+$/, '') : entry.dir,
    workspaceId: entry.workspaceId,
    serverUrl: entry.serverUrl,
    deviceId: entry.deviceId,
    createdAt: entry.createdAt,
  }
}

export async function loadRegistry(paths: GloveboxPaths): Promise<MountRegistry> {
  try {
    const raw = await readFile(paths.mountsFile, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<MountRegistry>
    return {
      version: 1,
      mounts: Array.isArray(parsed.mounts)
        ? parsed.mounts.map(parseMountEntry).filter((entry): entry is MountEntry => entry !== null)
        : [],
    }
  } catch {
    return { version: 1, mounts: [] }
  }
}

export async function saveRegistry(paths: GloveboxPaths, registry: MountRegistry): Promise<void> {
  await writeFileSecure(paths.mountsFile, JSON.stringify(registry, null, 2) + '\n')
}

/** The existing entry whose dir equals, contains, or is contained by `dir`. */
export function findOverlap(registry: MountRegistry, dir: string): MountEntry | null {
  for (const entry of registry.mounts) {
    if (dir === entry.dir || isInside(dir, entry.dir) || isInside(entry.dir, dir)) {
      return entry
    }
  }
  return null
}

function isInside(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

export function findMountByDir(registry: MountRegistry, dir: string): MountEntry | null {
  return registry.mounts.find((entry) => entry.dir === dir) ?? null
}

/** Deepest entry whose dir is `dir` or an ancestor of it (status/run UX). */
export function findMountForDir(registry: MountRegistry, dir: string): MountEntry | null {
  let best: MountEntry | null = null
  for (const entry of registry.mounts) {
    if (dir === entry.dir || isInside(dir, entry.dir)) {
      if (!best || entry.dir.length > best.dir.length) {
        best = entry
      }
    }
  }
  return best
}

/** Registry mutations are load-mutate-save — serialize them. */
function registryMutex(paths: GloveboxPaths): string {
  return `${paths.mountsFile}.mutex`
}

export async function addMount(paths: GloveboxPaths, entry: MountEntry): Promise<void> {
  await withDirMutex(registryMutex(paths), async () => {
    const registry = await loadRegistry(paths)
    const overlap = findOverlap(registry, entry.dir)
    if (overlap) {
      throw new Error(
        overlap.dir === entry.dir
          ? `${entry.dir} is already mounted (workspace ${overlap.workspaceId})`
          : `${entry.dir} overlaps the existing mount at ${overlap.dir} — nested mounts are not allowed`,
      )
    }
    registry.mounts.push(entry)
    await saveRegistry(paths, registry)
  })
}

export async function removeMount(paths: GloveboxPaths, mountId: string): Promise<void> {
  await withDirMutex(registryMutex(paths), async () => {
    const registry = await loadRegistry(paths)
    registry.mounts = registry.mounts.filter((entry) => entry.mountId !== mountId)
    await saveRegistry(paths, registry)
  })
}
