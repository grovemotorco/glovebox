import { os } from './index.ts'
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
  updateWorkspace,
} from './workspace-handlers.ts'
import {
  inviteMember,
  listMembers,
  removeMember,
  setMemberDocumentRole,
  setMemberOwner,
} from './member-handlers.ts'
import {
  acceptInvite,
  cancelInvite,
  createInvite,
  listInvites,
  resendInvite,
} from './invite-handlers.ts'
import { createApiKey, deleteApiKey, listApiKeys } from './key-handlers.ts'
import {
  approveDeviceAuthorization,
  mintWorkspaceSocketToken,
  pollDeviceAuthorization,
  startDeviceAuthorization,
  verifyWorkspaceSocketToken,
} from './auth-handlers.ts'
import {
  compareVersions,
  getCurrentDocumentVersion,
  getDocumentMetadata,
  listDocumentVersions,
  readDocumentText,
  readVersion,
} from './document-handlers.ts'
import { getWorkspaceTree, pushWorkspaceText, readWorkspaceText } from './text-handlers.ts'
import { getMe, listSessions, setActiveWorkspace } from './me-handlers.ts'
import {
  acknowledgeWorkspaceRecovery,
  getDocumentRecovery,
  listWorkspaceRecovery,
} from './recovery-handlers.ts'
import {
  acceptSuggestion,
  createComment,
  deleteComment,
  deleteSuggestion,
  listComments,
  listSuggestions,
  proposeSuggestion,
  rejectSuggestion,
  reopenComment,
  resolveComment,
} from './collaboration-handlers.ts'

const health = {
  check: os.health.check.handler(async () => ({
    ok: true as const,
    apiVersion: 'v1' as const,
    ts: Date.now(),
  })),
}

const auth = {
  deviceStart: os.auth.deviceStart.handler(async ({ input, context }) =>
    startDeviceAuthorization(input, context),
  ),
  devicePoll: os.auth.devicePoll.handler(async ({ input, context }) =>
    pollDeviceAuthorization(input, context),
  ),
  deviceApprove: os.auth.deviceApprove.handler(async ({ input, context }) =>
    approveDeviceAuthorization(input, context),
  ),
  mintWorkspaceSocketToken: os.auth.mintWorkspaceSocketToken.handler(async ({ input, context }) =>
    mintWorkspaceSocketToken(input, context),
  ),
  verifyWorkspaceSocketToken: os.auth.verifyWorkspaceSocketToken.handler(
    async ({ input, context }) => verifyWorkspaceSocketToken(input, context),
  ),
}

const me = {
  get: os.me.get.handler(async ({ context }) => getMe(context)),
  sessions: os.me.sessions.handler(async ({ context }) => listSessions(context)),
  setActiveWorkspace: os.me.setActiveWorkspace.handler(async ({ input, context }) =>
    setActiveWorkspace(input, context),
  ),
}

const workspaces = {
  create: os.workspaces.create.handler(async ({ input, context }) =>
    createWorkspace(input, context),
  ),
  list: os.workspaces.list.handler(async ({ context }) => listWorkspaces(context)),
  get: os.workspaces.get.handler(async ({ input, context }) => getWorkspace(input, context)),
  update: os.workspaces.update.handler(async ({ input, context }) =>
    updateWorkspace(input, context),
  ),
  delete: os.workspaces.delete.handler(async ({ input, context }) =>
    deleteWorkspace(input, context),
  ),
  tree: os.workspaces.tree.handler(async ({ input, context }) => getWorkspaceTree(input, context)),
  readText: os.workspaces.readText.handler(async ({ input, context }) =>
    readWorkspaceText(input, context),
  ),
  textPush: os.workspaces.textPush.handler(async ({ input, context }) =>
    pushWorkspaceText(input, context),
  ),
}

const members = {
  list: os.members.list.handler(async ({ input, context }) => listMembers(input, context)),
  invite: os.members.invite.handler(async ({ input, context }) => inviteMember(input, context)),
  remove: os.members.remove.handler(async ({ input, context }) => removeMember(input, context)),
  setDocumentRole: os.members.setDocumentRole.handler(async ({ input, context }) =>
    setMemberDocumentRole(input, context),
  ),
  setOwner: os.members.setOwner.handler(async ({ input, context }) =>
    setMemberOwner(input, context),
  ),
}

const invites = {
  create: os.invites.create.handler(async ({ input, context }) => createInvite(input, context)),
  list: os.invites.list.handler(async ({ input, context }) => listInvites(input, context)),
  resend: os.invites.resend.handler(async ({ input, context }) => resendInvite(input, context)),
  cancel: os.invites.cancel.handler(async ({ input, context }) => cancelInvite(input, context)),
  accept: os.invites.accept.handler(async ({ input, context }) => acceptInvite(input, context)),
}

const keys = {
  create: os.keys.create.handler(async ({ input, context }) => createApiKey(input, context)),
  list: os.keys.list.handler(async ({ context }) => listApiKeys(context)),
  delete: os.keys.delete.handler(async ({ input, context }) => deleteApiKey(input, context)),
}

const documents = {
  metadata: os.documents.metadata.handler(async ({ input, context }) =>
    getDocumentMetadata(input, context),
  ),
  currentVersion: os.documents.currentVersion.handler(async ({ input, context }) =>
    getCurrentDocumentVersion(input, context),
  ),
  versions: os.documents.versions.handler(async ({ input, context }) =>
    listDocumentVersions(input, context),
  ),
  readText: os.documents.readText.handler(async ({ input, context }) =>
    readDocumentText(input, context),
  ),
  recovery: os.documents.recovery.handler(async ({ input, context }) =>
    getDocumentRecovery(input, context),
  ),
  recoveryList: os.documents.recoveryList.handler(async ({ input, context }) =>
    listWorkspaceRecovery(input, context),
  ),
  recoveryAcknowledge: os.documents.recoveryAcknowledge.handler(async ({ input, context }) =>
    acknowledgeWorkspaceRecovery(input, context),
  ),
}

const comments = {
  create: os.comments.create.handler(async ({ input, context }) => createComment(input, context)),
  list: os.comments.list.handler(async ({ input, context }) => listComments(input, context)),
  resolve: os.comments.resolve.handler(async ({ input, context }) =>
    resolveComment(input, context),
  ),
  reopen: os.comments.reopen.handler(async ({ input, context }) => reopenComment(input, context)),
  delete: os.comments.delete.handler(async ({ input, context }) => deleteComment(input, context)),
}

const suggestions = {
  propose: os.suggestions.propose.handler(async ({ input, context }) =>
    proposeSuggestion(input, context),
  ),
  list: os.suggestions.list.handler(async ({ input, context }) => listSuggestions(input, context)),
  accept: os.suggestions.accept.handler(async ({ input, context }) =>
    acceptSuggestion(input, context),
  ),
  reject: os.suggestions.reject.handler(async ({ input, context }) =>
    rejectSuggestion(input, context),
  ),
  delete: os.suggestions.delete.handler(async ({ input, context }) =>
    deleteSuggestion(input, context),
  ),
}

const versions = {
  list: os.versions.list.handler(async ({ input, context }) =>
    listDocumentVersions(input, context),
  ),
  read: os.versions.read.handler(async ({ input, context }) => readVersion(input, context)),
  compare: os.versions.compare.handler(async ({ input, context }) =>
    compareVersions(input, context),
  ),
}

export const router = os.router({
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
})
