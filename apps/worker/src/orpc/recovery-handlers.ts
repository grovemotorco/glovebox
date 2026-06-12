import type { RecoveryRecord } from '@glovebox/api'
import { ORPCError } from '@orpc/server'
import type { ORPCContext } from './index.ts'
import { fetchWorkspaceDoAdmin, requireWorkspaceAccess } from './workspace-access.ts'

/**
 * Recovery & trash surface (ISSUE-0041) over the WorkspaceDO's
 * `workspace_recovery_records` store, bridged like the recheck/deleted
 * admin routes. Permission model per the issue: workspace READ access for
 * list and acknowledge — dismissing a record changes recovery UI state,
 * never workspace file content. Tighten to edit access later if that
 * proves too permissive.
 */

export async function getDocumentRecovery(
  input: { workspaceId: string; fileId: string },
  context: ORPCContext,
): Promise<{ fileId: string; available: boolean; records: RecoveryRecord[] }> {
  await requireWorkspaceAccess(context, input.workspaceId)
  const records = (await fetchRecoveryRecords(context, input.workspaceId, true)).filter(
    (record) => record.fileId === input.fileId,
  )
  return { fileId: input.fileId, available: records.length > 0, records }
}

export async function listWorkspaceRecovery(
  input: { workspaceId: string; includeAcknowledged?: boolean },
  context: ORPCContext,
): Promise<{ records: RecoveryRecord[] }> {
  await requireWorkspaceAccess(context, input.workspaceId)
  return {
    records: await fetchRecoveryRecords(context, input.workspaceId, !input.includeAcknowledged),
  }
}

export async function acknowledgeWorkspaceRecovery(
  input: { workspaceId: string; recordId: string },
  context: ORPCContext,
): Promise<{ acknowledged: boolean }> {
  await requireWorkspaceAccess(context, input.workspaceId)
  const response = await fetchWorkspaceDoAdmin(context, input.workspaceId, 'recovery/acknowledge', {
    recordId: input.recordId,
  })
  const body = await parseBridgeResponse(response, input.workspaceId)
  return { acknowledged: body.acknowledged === true }
}

async function fetchRecoveryRecords(
  context: ORPCContext,
  workspaceId: string,
  pendingOnly: boolean,
): Promise<RecoveryRecord[]> {
  const response = await fetchWorkspaceDoAdmin(context, workspaceId, 'recovery/list', {
    pendingOnly,
  })
  const body = await parseBridgeResponse(response, workspaceId)
  return Array.isArray(body.records) ? (body.records as RecoveryRecord[]) : []
}

async function parseBridgeResponse(
  response: Response,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const body = response.ok
    ? ((await response.json().catch(() => null)) as Record<string, unknown> | null)
    : null
  if (!body || body.ok !== true) {
    throw new ORPCError('INTERNAL_SERVER_ERROR', {
      status: 500,
      message: 'Workspace recovery bridge failed',
      data: { workspaceId },
    })
  }
  return body
}
