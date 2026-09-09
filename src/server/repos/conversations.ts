import { and, eq, lt, ne } from 'drizzle-orm';
import { getDb } from './db';
import { conversationMembers, conversations, friendships } from './schema';
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

// The friendship a conversation was created from — policy needs its `status`
// to decide whether messaging/calling is still allowed (docs/02 §5).
export async function getConversationFriendship(env: Env, conversationId: string) {
  const db = getDb(env);
  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  if (!conversation) return undefined;
  return db.query.friendships.findFirst({
    where: eq(friendships.id, conversation.friendshipId),
  });
}

// The other member of a (1:1, v1) conversation — used by policy to resolve
// which friendship/presence applies to "the peer" without trusting a client-
// supplied id.
export async function getOtherMember(env: Env, conversationId: string, userId: string) {
  const db = getDb(env);
  const row = await db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, conversationId),
      ne(conversationMembers.userId, userId),
    ),
  });
  return row?.userId;
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
