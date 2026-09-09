import { and, eq, lt } from 'drizzle-orm';
import { getDb } from './db';
import { conversationMembers, conversations } from './schema';
import type { Env } from '../env';
import type { Actor } from '../types';

// read conversation: row must exist in conversation_members for actor
// (docs/02 §5) — the membership join is the authorization check itself.
export async function getConversation(env: Env, actor: Actor, conversationId: string) {
  const db = getDb(env);
  const membership = await db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, actor.userId),
    ),
  });
  if (!membership) return undefined;

  return db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
}

export async function listConversationsForUser(env: Env, actor: Actor) {
  const db = getDb(env);
  const memberships = await db.query.conversationMembers.findMany({
    where: eq(conversationMembers.userId, actor.userId),
  });
  const ids = memberships.map((m) => m.conversationId);
  if (ids.length === 0) return [];

  const rows = await db.query.conversations.findMany();
  return rows.filter((r) => ids.includes(r.id));
}

// last_read_seq may only increase (docs/02 §5) — `gt` in the WHERE makes a
// stale/replayed update a no-op instead of a regression, and the row is
// scoped to the actor's own membership, never a userId argument.
export async function setLastReadSeq(
  env: Env,
  actor: Actor,
  conversationId: string,
  seq: number,
) {
  const db = getDb(env);
  const [row] = await db
    .update(conversationMembers)
    .set({ lastReadSeq: seq })
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, actor.userId),
        lt(conversationMembers.lastReadSeq, seq),
      ),
    )
    .returning();
  return row;
}
