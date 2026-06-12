import { describe, expect, test, vi } from 'vitest'
import {
  AWARENESS_CONSTANTS,
  createAgentUser,
  createAwarenessState,
  createBrowserUser,
  extractPresenceState,
  isUserInactive,
} from '../src/index.ts'

describe('awareness helpers', () => {
  test('createBrowserUser applies defaults and overrides', () => {
    const user = createBrowserUser({
      id: 'browser-1',
      name: 'Browser User',
      color: '#123456',
    })

    expect(user).toEqual({
      id: 'browser-1',
      name: 'Browser User',
      color: '#123456',
      type: 'browser',
    })
  })

  test('createAgentUser includes deviceName and agent type', () => {
    const user = createAgentUser('laptop-01', {
      id: 'agent-1',
      name: 'Sync Agent',
      color: '#654321',
    })

    expect(user).toEqual({
      id: 'agent-1',
      name: 'Sync Agent',
      color: '#654321',
      type: 'agent',
      deviceName: 'laptop-01',
    })
  })

  test('createAwarenessState captures cursor and current time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-20T06:00:00Z'))

    const state = createAwarenessState(
      {
        id: 'browser-1',
        name: 'Browser User',
        color: '#123456',
        type: 'browser',
      },
      { anchor: 2, head: 5 },
    )

    expect(state).toEqual({
      user: {
        id: 'browser-1',
        name: 'Browser User',
        color: '#123456',
        type: 'browser',
      },
      cursor: { anchor: 2, head: 5 },
      lastActive: new Date('2026-03-20T06:00:00Z').getTime(),
    })

    vi.useRealTimers()
  })

  test('isUserInactive uses the configured timeout', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-20T06:00:30Z'))

    const justInsideThreshold =
      new Date('2026-03-20T06:00:30Z').getTime() - AWARENESS_CONSTANTS.inactiveTimeoutMs
    const stale =
      new Date('2026-03-20T06:00:30Z').getTime() - AWARENESS_CONSTANTS.inactiveTimeoutMs - 1

    expect(isUserInactive(justInsideThreshold)).toBe(false)
    expect(isUserInactive(stale)).toBe(true)

    vi.useRealTimers()
  })

  test('extractPresenceState excludes the local client from remote cursors', () => {
    const localUser = createAwarenessState({
      id: 'local-user',
      name: 'Local',
      color: '#111111',
      type: 'browser',
    })

    const remoteUser = createAwarenessState(
      {
        id: 'remote-user',
        name: 'Remote',
        color: '#222222',
        type: 'agent',
        deviceName: 'sync-box',
      },
      { anchor: 10, head: 10 },
    )

    const result = extractPresenceState(
      new Map([
        [1, localUser],
        [2, remoteUser],
      ]),
      1,
    )

    expect(result.connectedCount).toBe(2)
    expect(result.users).toEqual([localUser.user, remoteUser.user])
    expect(result.remoteCursors).toEqual([
      {
        user: remoteUser.user,
        cursor: { anchor: 10, head: 10 },
        lastActive: remoteUser.lastActive,
      },
    ])
  })
})
