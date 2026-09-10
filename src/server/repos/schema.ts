// Drizzle schema for D1 — source of truth for `pnpm drizzle-kit generate`.
// Mirrors docs/02-DATA-MODEL.md §1 exactly; do not hand-edit migrations/*.sql.
//
// `user`/`session`/`account`/`verification` are Better Auth's tables. They're
// hand-defined here (matching docs/02) because Better Auth itself isn't wired
// until M3 — once `npx @better-auth/cli generate` runs, replace this block
// with its output rather than editing by hand.
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

// `{ mode: 'timestamp' | 'boolean' }` on these columns (but not our own
// app tables below, which store epoch millis as plain numbers) because
// Better Auth's internal model always produces JS `Date`/`boolean` values for
// these fields and hands them to the adapter as-is — bound to D1 without
// drizzle's mode-driven serialization, a bare `Date` object 500s with
// `D1_TYPE_ERROR: Type 'object' not supported`.
export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('emailVerified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
});

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
    ipAddress: text('ipAddress'),
    userAgent: text('userAgent'),
    createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('idx_session_user').on(t.userId)],
);

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accountId: text('accountId').notNull(),
  providerId: text('providerId').notNull(),
  password: text('password'),
  // Unused while email/password is the only provider (no OAuth plugin
  // configured) — present because Better Auth's core `account` model always
  // includes them; the drizzle adapter validates the full model shape at
  // startup and errors if they're missing.
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  idToken: text('idToken'),
  accessTokenExpiresAt: integer('accessTokenExpiresAt', { mode: 'timestamp' }),
  refreshTokenExpiresAt: integer('refreshTokenExpiresAt', { mode: 'timestamp' }),
  scope: text('scope'),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
});

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
});

// ── app profile (1:1 with user; keeps our columns out of Better Auth's table)
export const profiles = sqliteTable(
  'profiles',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    avatarKey: text('avatar_key'),
    statusText: text('status_text'),
    lastSeenAt: integer('last_seen_at').notNull().default(0),
    storageUsed: integer('storage_used').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    check('chk_profiles_display_name', sql`length(${t.displayName}) BETWEEN 1 AND 50`),
    check(
      'chk_profiles_status_text',
      sql`${t.statusText} IS NULL OR length(${t.statusText}) <= 140`,
    ),
  ],
);

// ── friendships: ONE row per pair, canonical order (user_a < user_b lexically)
export const friendships = sqliteTable(
  'friendships',
  {
    id: text('id').primaryKey(),
    userA: text('user_a')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    userB: text('user_b')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    requestedBy: text('requested_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    blockedBy: text('blocked_by').references(() => user.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('pending'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('idx_fr_a').on(t.userA, t.status),
    index('idx_fr_b').on(t.userB, t.status),
    unique('uq_fr_pair').on(t.userA, t.userB),
    check(
      'chk_fr_status',
      sql`${t.status} IN ('pending','accepted','declined','blocked')`,
    ),
    check('chk_fr_order', sql`${t.userA} < ${t.userB}`),
    check('chk_fr_distinct', sql`${t.userA} <> ${t.userB}`),
  ],
);

// ── invitations to non-users
export const invitations = sqliteTable(
  'invitations',
  {
    id: text('id').primaryKey(),
    inviterId: text('inviter_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    claimedBy: text('claimed_by').references(() => user.id, { onDelete: 'set null' }),
    claimedAt: integer('claimed_at'),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('idx_inv_inviter').on(t.inviterId, t.createdAt),
    index('idx_inv_email').on(t.email),
  ],
);

// ── conversations (v1: exactly one per accepted friendship)
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  friendshipId: text('friendship_id')
    .notNull()
    .unique()
    .references(() => friendships.id, { onDelete: 'cascade' }),
  lastMessageAt: integer('last_message_at'),
  lastMessagePreview: text('last_message_preview'),
  lastMessageSender: text('last_message_sender'),
  lastSeq: integer('last_seq').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const conversationMembers = sqliteTable(
  'conversation_members',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    lastReadSeq: integer('last_read_seq').notNull().default(0),
    mutedUntil: integer('muted_until'),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId] }),
    index('idx_cm_user').on(t.userId),
  ],
);

// ── attachments (metadata in D1, bytes in R2)
export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    uploaderId: text('uploader_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    r2Key: text('r2_key').notNull().unique(),
    mimeType: text('mime_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    originalName: text('original_name'),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    waveform: text('waveform'),
    status: text('status').notNull().default('pending'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('idx_att_conv').on(t.conversationId),
    index('idx_att_pending').on(t.status, t.createdAt),
    check('chk_att_status', sql`${t.status} IN ('pending','ready','failed','deleted')`),
    check('chk_att_size', sql`${t.byteSize} > 0 AND ${t.byteSize} <= 26214400`),
  ],
);

// ── calls (history; live state lives in CallDO)
export const calls = sqliteTable(
  'calls',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    callerId: text('caller_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    calleeId: text('callee_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('ringing'),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    endReason: text('end_reason'),
    iceRelayed: integer('ice_relayed'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('idx_calls_conv').on(t.conversationId, t.createdAt),
    index('idx_calls_active').on(t.calleeId, t.status),
    check(
      'chk_calls_status',
      sql`${t.status} IN ('ringing','active','ended','missed','declined','failed')`,
    ),
  ],
);

// ── push subscriptions
export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: integer('created_at').notNull(),
    lastOkAt: integer('last_ok_at'),
  },
  (t) => [index('idx_push_user').on(t.userId)],
);

// ── account deletion (docs/05 §9): grace-period row created on `DELETE
// /api/account`, swept by a daily cron once `purge_at` is due. One row per
// user — a fresh delete request while one is already pending just re-reads
// the existing row (see repos/account.ts).
export const accountDeletions = sqliteTable('account_deletions', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  requestedAt: integer('requested_at').notNull(),
  purgeAt: integer('purge_at').notNull(),
  status: text('status').notNull().default('pending'),
}, (t) => [
  index('idx_acct_del_purge_at').on(t.status, t.purgeAt),
  check('chk_acct_del_status', sql`${t.status} IN ('pending','purged')`),
]);

// ── account export jobs (docs/03 `POST /api/account/export`)
export const exportJobs = sqliteTable(
  'export_jobs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'),
    r2Key: text('r2_key'),
    error: text('error'),
    requestedAt: integer('requested_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (t) => [
    index('idx_export_user').on(t.userId, t.requestedAt),
    check('chk_export_status', sql`${t.status} IN ('pending','ready','failed')`),
  ],
);

// ── abuse
export const reports = sqliteTable('reports', {
  id: text('id').primaryKey(),
  reporterId: text('reporter_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  targetId: text('target_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id'),
  messageSeq: integer('message_seq'),
  reason: text('reason').notNull(),
  createdAt: integer('created_at').notNull(),
});
