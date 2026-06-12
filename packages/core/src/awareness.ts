/**
 * Cursor position stored as JSON-encoded Yjs RelativePositions.
 *
 * RelativePositions are bound to CRDT item IDs, so they automatically
 * resolve to the correct absolute offset even after remote edits shift
 * the surrounding text. This is the standard pattern for real-time
 * cursors in Yjs-backed editors.
 *
 * Create with: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(yText, offset))
 * Resolve with: Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), doc)
 */
export interface CursorPosition {
  anchor: unknown
  head: unknown
}

export interface AwarenessUser {
  id: string
  name: string
  color: string
  type: 'browser' | 'agent'
  deviceName?: string
}

export interface AwarenessState {
  user: AwarenessUser
  cursor: CursorPosition | null
  lastActive: number
}

export interface RemoteCursor {
  user: AwarenessUser
  cursor: CursorPosition | null
  lastActive: number
}

export interface PresenceState {
  remoteCursors: RemoteCursor[]
  users: AwarenessUser[]
  connectedCount: number
}

export const AWARENESS_CONSTANTS = {
  inactiveTimeoutMs: 30_000,
  heartbeatIntervalMs: 30_000,
} as const

const USER_COLORS = [
  '#f87171',
  '#fb923c',
  '#fbbf24',
  '#a3e635',
  '#4ade80',
  '#2dd4bf',
  '#22d3ee',
  '#60a5fa',
  '#a78bfa',
  '#e879f9',
  '#fb7185',
] as const

const USER_ADJECTIVES = [
  'Swift',
  'Bright',
  'Calm',
  'Clever',
  'Daring',
  'Eager',
  'Fancy',
  'Gentle',
  'Happy',
  'Jolly',
  'Kind',
  'Lively',
  'Merry',
  'Noble',
  'Proud',
  'Quick',
  'Sunny',
  'Witty',
  'Brave',
  'Cosmic',
] as const

const USER_ANIMALS = [
  'Panda',
  'Owl',
  'Fox',
  'Bear',
  'Wolf',
  'Eagle',
  'Hawk',
  'Deer',
  'Lion',
  'Tiger',
  'Otter',
  'Koala',
  'Raven',
  'Falcon',
  'Badger',
  'Heron',
  'Lynx',
  'Moose',
  'Whale',
  'Seal',
] as const

export function generateUserColor(): string {
  return USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)] ?? '#60a5fa'
}

export function generateAnonymousName(): string {
  const adjective = USER_ADJECTIVES[Math.floor(Math.random() * USER_ADJECTIVES.length)] ?? 'Bright'
  const animal = USER_ANIMALS[Math.floor(Math.random() * USER_ANIMALS.length)] ?? 'Panda'

  return `${adjective} ${animal}`
}

export function createAwarenessState(
  user: AwarenessUser,
  cursor: CursorPosition | null = null,
): AwarenessState {
  return {
    user,
    cursor,
    lastActive: Date.now(),
  }
}

export function createBrowserUser(overrides: Partial<AwarenessUser> = {}): AwarenessUser {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? generateAnonymousName(),
    color: overrides.color ?? generateUserColor(),
    type: 'browser',
    ...overrides,
  }
}

export function createAgentUser(
  deviceName: string,
  overrides: Partial<Omit<AwarenessUser, 'type' | 'deviceName'>> = {},
): AwarenessUser {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? `Agent (${deviceName})`,
    color: overrides.color ?? generateUserColor(),
    type: 'agent',
    deviceName,
  }
}

export function isUserInactive(
  lastActive: number,
  timeout: number = AWARENESS_CONSTANTS.inactiveTimeoutMs,
): boolean {
  return Date.now() - lastActive > timeout
}

export function extractPresenceState(
  states: Map<number, AwarenessState>,
  localClientId: number,
): PresenceState {
  const remoteCursors: RemoteCursor[] = []
  const users: AwarenessUser[] = []

  for (const [clientId, state] of states) {
    if (!state?.user) {
      continue
    }

    users.push(state.user)

    if (clientId !== localClientId) {
      remoteCursors.push({
        user: state.user,
        cursor: state.cursor,
        lastActive: state.lastActive,
      })
    }
  }

  return {
    remoteCursors,
    users,
    connectedCount: users.length,
  }
}
