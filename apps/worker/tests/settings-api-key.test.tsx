/* @vitest-environment happy-dom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsModal } from '../src/components/SettingsModal.tsx'

const apiMock = vi.hoisted(() => ({
  keys: {
    create: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  },
}))

const uiMock = vi.hoisted(() => ({
  closeSettingsModal: vi.fn(),
  setAutoSync: vi.fn(),
  setEditorMode: vi.fn(),
}))

const workspaceMock = vi.hoisted(() => ({
  workspace: {
    id: 'ws-settings',
    name: 'Settings Workspace',
    slug: 'settings-workspace',
    currentPrincipalOwner: true,
  } as {
    id: string
    name: string
    slug: string
    currentPrincipalOwner: boolean
  } | null,
  workspaceId: 'ws-settings' as string | null,
  refreshWorkspaces: vi.fn(),
}))

vi.mock('../src/lib/api.ts', () => ({
  api: apiMock,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  safe: async (promise: Promise<unknown>) => {
    try {
      return { error: null, data: await promise, isDefined: false, isSuccess: true }
    } catch (error) {
      return { error, data: undefined, isDefined: false, isSuccess: false }
    }
  },
}))

vi.mock('../src/state/ui.ts', () => ({
  useUiState: () => ({
    settingsModalOpen: true,
    editorMode: 'combined',
    autoSync: true,
  }),
  useUiActions: () => uiMock,
}))

vi.mock('../src/state/workspace.tsx', () => ({
  useWorkspace: () => ({
    workspace: workspaceMock.workspace,
    workspaceId: workspaceMock.workspaceId,
    refreshWorkspaces: workspaceMock.refreshWorkspaces,
    members: [],
    refreshMembers: vi.fn(),
    invites: [],
    refreshInvites: vi.fn(),
    principalId: 'human-user',
  }),
}))

let root: Root | null = null

describe('Settings API key creation', () => {
  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    apiMock.keys.create.mockReset().mockResolvedValue({ plaintext: 'gbx_created' })
    apiMock.keys.list.mockReset().mockResolvedValue({ keys: [] })
    apiMock.keys.delete.mockReset()
    workspaceMock.workspace = {
      id: 'ws-settings',
      name: 'Settings Workspace',
      slug: 'settings-workspace',
      currentPrincipalOwner: true,
    }
    workspaceMock.workspaceId = 'ws-settings'
    workspaceMock.refreshWorkspaces.mockReset()
    document.body.replaceChildren()
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {})
  })

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount())
      root = null
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('mints a workspace CLI key with the read and write scopes needed for sync', async () => {
    await renderAccessTab()
    await waitFor(() => apiMock.keys.list.mock.calls.length > 0)

    const nameInput = document.querySelector<HTMLInputElement>('input[aria-label="Key name"]')
    if (!nameInput) throw new Error('Key name input not found')
    await setInputValue(nameInput, 'Laptop CLI')
    await clickButton('Create')
    await waitFor(() => apiMock.keys.create.mock.calls.length > 0)

    expect(apiMock.keys.create).toHaveBeenCalledWith({
      name: 'Laptop CLI',
      purpose: 'cli',
      scopes: ['workspace:read', 'workspace:write'],
      workspaceIds: ['ws-settings'],
    })
  })

  it('does not create an account-wide key when no workspace is active', async () => {
    workspaceMock.workspace = null
    workspaceMock.workspaceId = null
    await renderAccessTab()

    const nameInput = document.querySelector<HTMLInputElement>('input[aria-label="Key name"]')
    if (!nameInput) throw new Error('Key name input not found')
    await setInputValue(nameInput, 'Unscoped CLI')

    const createButton = findButton('Create')
    expect(createButton.disabled).toBe(true)
    await act(async () => createButton.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(apiMock.keys.create).not.toHaveBeenCalled()
  })
})

async function renderAccessTab(): Promise<void> {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(<SettingsModal />))
  await clickButton('Sync & Access')
}

async function clickButton(label: string): Promise<void> {
  const button = findButton(label)
  await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

function findButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!button) throw new Error(`Button not found: ${label}`)
  return button
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  if (!descriptor?.set) throw new Error('HTMLInputElement value setter not found')
  await act(async () => {
    descriptor.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function waitFor(assertion: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (assertion()) return
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition')
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  }
}
