import { eq } from 'drizzle-orm';
import { getDb } from './db';
import { attachments } from './schema';
import { uuidv7 } from '../../shared/id';
import type { Env } from '../env';
import type { Actor } from '../types';

export type CreateAttachmentInput = {
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
      id: uuidv7(),
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
  meta: { width?: number; height?: number; durationMs?: number; waveform?: string },
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
