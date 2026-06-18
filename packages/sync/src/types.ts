import type { DeviceTag } from '@glovebox.md/core'

export interface VerifiedSyncConnection {
  workspaceId: string
  epoch: number
  tag: DeviceTag
  clientId?: string
  sinceSeq?: number
}

export interface SyncAuthorizer {
  readCurrentEpoch(workspaceId: string): Promise<number | null>
  updateCachedEpoch(workspaceId: string, epoch: number | null): Promise<void> | void
}
