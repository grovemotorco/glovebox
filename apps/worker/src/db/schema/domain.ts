import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { apiKey, user } from './auth.ts'

export const principal = sqliteTable(
  'principal',
  {
    id: text('id').primaryKey(),
    type: text('type', { enum: ['human', 'agent'] }).notNull(),
    userId: text('userId').references(() => user.id, { onDelete: 'cascade' }),
    displayName: text('displayName').notNull(),
    email: text('email'),
    createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('idx_principal_userId').on(t.userId),
    index('idx_principal_email').on(t.email),
  ],
)

export const workspace = sqliteTable(
  'workspace',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug'),
    authEpoch: integer('authEpoch').notNull().default(0),
    deletedAt: integer('deletedAt', { mode: 'timestamp_ms' }),
    createdByPrincipalId: text('createdByPrincipalId')
      .notNull()
      .references(() => principal.id, { onDelete: 'restrict' }),
    createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('idx_workspace_slug').on(t.slug),
    index('idx_workspace_createdByPrincipalId').on(t.createdByPrincipalId),
  ],
)

export const workspaceMember = sqliteTable(
  'workspaceMember',
  {
    workspaceId: text('workspaceId')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    principalId: text('principalId')
      .notNull()
      .references(() => principal.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['viewer', 'commenter', 'editor'] }).notNull(),
    owner: integer('owner', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.principalId] }),
    index('idx_workspaceMember_principalId').on(t.principalId),
  ],
)

export const workspaceInvite = sqliteTable(
  'workspaceInvite',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspaceId')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: ['viewer', 'commenter', 'editor'] }).notNull(),
    owner: integer('owner', { mode: 'boolean' }).notNull().default(false),
    tokenHash: text('tokenHash').notNull(),
    status: text('status', { enum: ['pending', 'accepted', 'canceled', 'expired'] }).notNull(),
    invitedByPrincipalId: text('invitedByPrincipalId')
      .notNull()
      .references(() => principal.id, { onDelete: 'restrict' }),
    acceptedByPrincipalId: text('acceptedByPrincipalId').references(() => principal.id, {
      onDelete: 'set null',
    }),
    createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).notNull(),
    expiresAt: integer('expiresAt', { mode: 'timestamp_ms' }).notNull(),
    acceptedAt: integer('acceptedAt', { mode: 'timestamp_ms' }),
  },
  (t) => [
    uniqueIndex('idx_workspaceInvite_tokenHash').on(t.tokenHash),
    index('idx_workspaceInvite_workspaceId').on(t.workspaceId),
    index('idx_workspaceInvite_email').on(t.email),
  ],
)

export const apiKeyMetadata = sqliteTable(
  'apiKeyMetadata',
  {
    apiKeyId: text('apiKeyId')
      .primaryKey()
      .references(() => apiKey.id, { onDelete: 'cascade' }),
    principalId: text('principalId')
      .notNull()
      .references(() => principal.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: ['cli', 'agent', 'api'] }).notNull(),
    scopesJson: text('scopesJson').notNull().default('[]'),
    workspaceIdsJson: text('workspaceIdsJson').notNull().default('[]'),
    createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).notNull(),
    lastUsedAt: integer('lastUsedAt', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('idx_apiKeyMetadata_principalId').on(t.principalId),
    index('idx_apiKeyMetadata_purpose').on(t.purpose),
  ],
)

export const workspaceDocument = sqliteTable(
  'workspaceDocument',
  {
    workspaceId: text('workspaceId')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    fileId: text('fileId').notNull(),
    path: text('path').notNull(),
    contentKind: text('contentKind', { enum: ['markdown', 'opaque'] }).notNull(),
    sizeBytes: integer('sizeBytes').notNull().default(0),
    currentVersionId: text('currentVersionId'),
    updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.fileId] }),
    index('idx_workspaceDocument_workspaceId_path').on(t.workspaceId, t.path),
  ],
)

export const documentVersion = sqliteTable(
  'documentVersion',
  {
    workspaceId: text('workspaceId').notNull(),
    fileId: text('fileId').notNull(),
    versionId: text('versionId').notNull(),
    seq: integer('seq').notNull(),
    contentVersionB64: text('contentVersionB64').notNull(),
    text: text('text').notNull().default(''),
    createdByPrincipalId: text('createdByPrincipalId')
      .notNull()
      .references(() => principal.id, { onDelete: 'restrict' }),
    createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull(),
    label: text('label'),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.fileId, t.versionId] }),
    index('idx_documentVersion_fileId_createdAt').on(t.workspaceId, t.fileId, t.createdAt),
  ],
)

export const commentThread = sqliteTable(
  'commentThread',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspaceId').notNull(),
    fileId: text('fileId').notNull(),
    baseVersionId: text('baseVersionId').notNull(),
    rangeStart: integer('rangeStart').notNull(),
    rangeEnd: integer('rangeEnd').notNull(),
    rangeStale: integer('rangeStale', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: ['open', 'resolved'] }).notNull(),
    body: text('body').notNull(),
    authorPrincipalId: text('authorPrincipalId')
      .notNull()
      .references(() => principal.id, { onDelete: 'restrict' }),
    createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).notNull(),
    resolvedAt: integer('resolvedAt', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('idx_commentThread_workspace_file').on(t.workspaceId, t.fileId),
    index('idx_commentThread_status').on(t.status),
  ],
)

export const suggestion = sqliteTable(
  'suggestion',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspaceId').notNull(),
    fileId: text('fileId').notNull(),
    baseVersionId: text('baseVersionId').notNull(),
    rangeStart: integer('rangeStart').notNull(),
    rangeEnd: integer('rangeEnd').notNull(),
    rangeStale: integer('rangeStale', { mode: 'boolean' }).notNull().default(false),
    replacementText: text('replacementText').notNull(),
    status: text('status', { enum: ['open', 'accepted', 'rejected'] }).notNull(),
    authorPrincipalId: text('authorPrincipalId')
      .notNull()
      .references(() => principal.id, { onDelete: 'restrict' }),
    createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull(),
    decidedByPrincipalId: text('decidedByPrincipalId').references(() => principal.id, {
      onDelete: 'set null',
    }),
    decidedAt: integer('decidedAt', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('idx_suggestion_workspace_file').on(t.workspaceId, t.fileId),
    index('idx_suggestion_status').on(t.status),
  ],
)
