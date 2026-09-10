import { eq } from 'drizzle-orm';
import { getDb } from './db';
import { attachments } from './schema';
import { uuidv7 } from '../../shared/id';
import type { Env } from '../env';
import type { Actor } from '../types';

export type CreateAttachmentInput = {
  // Callers that must know the id before the row exists — e.g. the `/sign`
  // route, which builds `r2Key` from it — pass one in; otherwise the repo
  // generates its own (the policy suite's tests do this, docs/07 §2).
  id?: string;
  conversationId: string;
  r2Key: string;
  mimeType: string;
  byteSize: number;
  originalName?: string;
};

// The full "member + quota" check is `policy.assertCanSignAttachmentUpload`;
// this repo only guarantees the row is attributed to the actual caller, never
// a spoofed id.
export async function createPendingAttachment(
  env: Env,
  actor: Actor,
  input: CreateAttachmentInput,
) {
  const db = getDb(env);
  const [row] = await db
    .insert(attachments)
    .values({
      id: input.id ?? uuidv7(),
      conversationId: input.conversationId,
      uploaderId: actor.userId,
      r2Key: input.r2Key,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      originalName: input.originalName,
      status: 'pending',
      createdAt: Date.now(),
    })
    .returning();
  return row;
}

export async function markAttachmentReady(
  env: Env,
  actor: Actor,
  id: string,
  meta: {
    width?: number | undefined;
    height?: number | undefined;
    durationMs?: number | undefined;
    waveform?: string | undefined;
  },
) {
  const db = getDb(env);
  const [row] = await db
    .update(attachments)
    .set({ status: 'ready', ...meta })
    .where(eq(attachments.id, id))
    .returning();
  void actor; // caller re-checks uploader/member via policy before this runs
  return row;
}

// Sniffed MIME didn't match the declared type, or the object doesn't exist /
// wrong size (docs/03 "Attachments": "else object deleted and row `failed`").
// The R2 object itself is deleted by the caller (route), which is the one
// that already has `env.MEDIA` in scope from the HEAD it just did.
export async function markAttachmentFailed(env: Env, id: string) {
  const db = getDb(env);
  const [row] = await db
    .update(attachments)
    .set({ status: 'failed' })
    .where(eq(attachments.id, id))
    .returning();
  return row;
}

export async function deleteAttachmentRow(env: Env, id: string) {
  const db = getDb(env);
  await db.delete(attachments).where(eq(attachments.id, id));
}

export async function getAttachment(env: Env, actor: Actor, id: string) {
  void actor;
  const db = getDb(env);
  return db.query.attachments.findFirst({ where: eq(attachments.id, id) });
}

// System caller (orphan-sweep cron, docs/01 §4.2) — not tied to a single
// user, so it does not take an Actor.
export async function listPendingOlderThan(env: Env, cutoffMs: number) {
  const db = getDb(env);
  const rows = await db.query.attachments.findMany({
    where: eq(attachments.status, 'pending'),
  });
  return rows.filter((r) => r.createdAt < cutoffMs);
}

// System caller (account export/purge, docs/05 §9) — every attachment this
// user ever uploaded, across every conversation, so the R2 bytes can be
// exported/deleted by key before the D1 cascade removes these rows.
export async function listByUploader(env: Env, uploaderId: string) {
  const db = getDb(env);
  return db.query.attachments.findMany({ where: eq(attachments.uploaderId, uploaderId) });
}
