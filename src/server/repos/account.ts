import { and, eq, lte } from 'drizzle-orm';
import { getDb } from './db';
import { accountDeletions, exportJobs, profiles, user } from './schema';
import { uuidv7 } from '../../shared/id';
import type { Env } from '../env';
import type { Actor } from '../types';

const PURGE_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // docs/05 §9: 30-day grace period

// ── account deletion (grace period) ────────────────────────────────────────
export async function getPendingDeletion(env: Env, userId: string) {
  const db = getDb(env);
  return db.query.accountDeletions.findFirst({ where: eq(accountDeletions.userId, userId) });
}

// Idempotent: a second `DELETE /api/account` while one is already pending
// just returns the existing row rather than resetting the 30-day clock.
export async function scheduleAccountDeletion(env: Env, actor: Actor) {
  const existing = await getPendingDeletion(env, actor.userId);
  if (existing) return existing;
  const db = getDb(env);
  const now = Date.now();
  const [row] = await db
    .insert(accountDeletions)
    .values({ userId: actor.userId, requestedAt: now, purgeAt: now + PURGE_GRACE_MS, status: 'pending' })
    .returning();
  return row;
}

// System caller (daily purge cron) — every row whose grace period has
// elapsed, still `pending` (never re-selects one already `purged`).
export async function listDueDeletions(env: Env, now: number) {
  const db = getDb(env);
  return db.query.accountDeletions.findMany({
    where: and(eq(accountDeletions.status, 'pending'), lte(accountDeletions.purgeAt, now)),
  });
}

export async function deleteAccountDeletionRow(env: Env, userId: string) {
  const db = getDb(env);
  await db.delete(accountDeletions).where(eq(accountDeletions.userId, userId));
}

// Hard purge: deletes the Better Auth `user` row, which cascades every
// FK-linked table (profiles, friendships, invitations, conversations,
// conversation_members, attachments, calls, push_subscriptions, reports —
// docs/02 §1). DO storage and R2 objects don't cascade from a D1 delete —
// callers (src/server/lib/account-purge.ts) handle those first.
export async function hardDeleteUser(env: Env, userId: string) {
  const db = getDb(env);
  await db.delete(user).where(eq(user.id, userId));
}

// ── profile anonymization (immediate, at request time) ─────────────────────
export async function anonymizeProfile(env: Env, actor: Actor) {
  const db = getDb(env);
  const [row] = await db
    .update(profiles)
    .set({ displayName: 'Deleted user', avatarKey: null, statusText: null })
    .where(eq(profiles.userId, actor.userId))
    .returning();
  return row;
}

// ── export jobs ──────────────────────────────────────────────────────────
export async function createExportJob(env: Env, actor: Actor) {
  const db = getDb(env);
  const [row] = await db
    .insert(exportJobs)
    .values({ id: uuidv7(), userId: actor.userId, status: 'pending', requestedAt: Date.now() })
    .returning();
  return row;
}

export async function getExportJob(env: Env, jobId: string) {
  const db = getDb(env);
  return db.query.exportJobs.findFirst({ where: eq(exportJobs.id, jobId) });
}

export async function markExportJobReady(env: Env, jobId: string, r2Key: string) {
  const db = getDb(env);
  const [row] = await db
    .update(exportJobs)
    .set({ status: 'ready', r2Key, completedAt: Date.now() })
    .where(eq(exportJobs.id, jobId))
    .returning();
  return row;
}

export async function markExportJobFailed(env: Env, jobId: string, error: string) {
  const db = getDb(env);
  const [row] = await db
    .update(exportJobs)
    .set({ status: 'failed', error, completedAt: Date.now() })
    .where(eq(exportJobs.id, jobId))
    .returning();
  return row;
}
