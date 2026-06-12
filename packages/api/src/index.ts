export const apiVersion = 'v1'

export {
  auth,
  type DeviceAuthorizationStartInput,
  type DeviceAuthorizationStartOutput,
  type WorkspaceSocketTokenOutput,
} from './auth.ts'
export { comments, commentThreadSchema, type CommentThread } from './comments.ts'
export { documents, recoveryRecordSchema, type RecoveryRecord } from './documents.ts'
export { health } from './health.ts'
export { invites, inviteViewSchema, type InviteView } from './invites.ts'
export {
  keys,
  apiKeyCreateOutputSchema,
  apiKeyViewSchema,
  type ApiKeyCreateOutput,
  type ApiKeyView,
} from './keys.ts'
export { me, meViewSchema, sessionViewSchema, type MeView, type SessionView } from './me.ts'
export { members, memberViewSchema, type MemberView } from './members.ts'
export { suggestions, suggestionSchema, type Suggestion } from './suggestions.ts'
export { versions } from './versions.ts'
export {
  workspaces,
  textPushResultSchema,
  type TextPushInput,
  type TextPushResult,
  type WorkspaceCreateInput,
  type WorkspaceUpdateInput,
} from './workspaces.ts'
export { commonErrors, ocBase, ocPublic, type CommonErrorMap } from './base.ts'
export {
  assertApiKey,
  createGloveboxCliClient,
  createGloveboxClient,
  createGloveboxWebClient,
  rpcUrl,
  type GloveboxApiKeyClientOptions,
  type GloveboxClient,
  type GloveboxClientOptions,
  type SafeGloveboxClient,
} from './client.ts'
export {
  base64StringSchema,
  cursorSchema,
  documentMetadataSchema,
  documentRoleSchema,
  documentVersionSchema,
  emailSchema,
  idSchema,
  keyPurposeSchema,
  paginationInputSchema,
  principalSchema,
  principalTypeSchema,
  rangeAnchorSchema,
  workspaceRelativePathSchema,
  workspaceSummarySchema,
  workspaceTreeEntrySchema,
  type DocumentMetadata,
  type DocumentRole,
  type DocumentVersion,
  type KeyPurpose,
  type PrincipalType,
  type WorkspaceSummary,
  type WorkspaceTreeEntry,
} from './schemas.ts'

import { auth } from './auth.ts'
import { comments } from './comments.ts'
import { documents } from './documents.ts'
import { health } from './health.ts'
import { invites } from './invites.ts'
import { keys } from './keys.ts'
import { me } from './me.ts'
import { members } from './members.ts'
import { suggestions } from './suggestions.ts'
import { versions } from './versions.ts'
import { workspaces } from './workspaces.ts'

export const contract = {
  health,
  auth,
  me,
  workspaces,
  members,
  invites,
  keys,
  documents,
  comments,
  suggestions,
  versions,
}

export type Contract = typeof contract
