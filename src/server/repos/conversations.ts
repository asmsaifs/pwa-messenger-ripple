import { and, eq, inArray, lt, ne } from 'drizzle-orm';
import { getDb } from './db';
import { conversationMembers, conversations, friendships, profiles } from './schema';
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

export async function getOwnMembership(env: Env, actor: Actor, conversationId: string) {
  const db = getDb(env);
  return db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, actor.userId),
    ),
  });
}

export async function listConversationsForUser(env: Env, actor: Actor) {
  const db = getDb(env);
  const memberships = await db.query.conversationMembers.findMany({
    where: eq(conversationMembers.userId, actor.userId),
  });
  const ids = memberships.map((m) => m.conversationId);
  if (ids.length === 0) return [];

  const rows = await db.query.conversations.findMany({
    where: inArray(conversations.id, ids),
  });
  return rows;
}

// GET /api/conversations — joins in the actor's own membership row (for
// `lastReadSeq`/`mutedUntil`), the other member's userId, and their profile,
// so the route never has to fan out per-row (mirrors
// friendsRepo.listFriendshipsWithProfiles's shape).
export async function listConversationsForUserWithDetails(env: Env, actor: Actor) {
  const db = getDb(env);
  const memberships = await db.query.conversationMembers.findMany({
    where: eq(conversationMembers.userId, actor.userId),
  });
  if (memberships.length === 0) return [];

  const conversationIds = memberships.map((m) => m.conversationId);
  const [conversationRows, otherMemberRows] = await Promise.all([
    db.query.conversations.findMany({ where: inArray(conversations.id, conversationIds) }),
    db.query.conversationMembers.findMany({
      where: and(
        inArray(conversationMembers.conversationId, conversationIds),
        ne(conversationMembers.userId, actor.userId),
      ),
    }),
  ]);
  const conversationById = new Map(conversationRows.map((c) => [c.id, c]));
  const otherMemberByConversation = new Map(
    otherMemberRows.map((m) => [m.conversationId, m.userId]),
  );
  const peerIds = [...otherMemberByConversation.values()];
  const profileRows = peerIds.length
    ? await db.query.profiles.findMany({ where: inArray(profiles.userId, peerIds) })
    : [];
  const profileById = new Map(profileRows.map((p) => [p.userId, p]));

  return memberships
    .map((membership) => {
      const conversation = conversationById.get(membership.conversationId);
      const peerUserId = otherMemberByConversation.get(membership.conversationId);
      if (!conversation || !peerUserId) return undefined;
      return { conversation, membership, peerUserId, peerProfile: profileById.get(peerUserId) };
    })
    .filter((row) => row !== undefined);
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

export async function setMutedUntil(
  env: Env,
  actor: Actor,
  conversationId: string,
  until: number | null,
) {
  const db = getDb(env);
  const [row] = await db
    .update(conversationMembers)
    .set({ mutedUntil: until })
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, actor.userId),
      ),
    )
    .returning();
  return row;
}

// Non-actor: called by ConversationDO to re-verify a WS-attached userId
// (docs/01 §5 trust boundary) — there's no session/Actor at the DO layer,
// only the identity pinned into `ws.serializeAttachment` after the Worker's
// own `assertConversationMember` already ran once at upgrade time.
export async function getMembershipStatus(
  env: Env,
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const db = getDb(env);
  const row = await db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, userId),
    ),
  });
  return row !== undefined;
}

// The one D1 write ConversationDO makes (docs/01 §3 "the one crossing"),
// via its debounced alarm — DO storage is the source of truth for messages,
// this just keeps the D1-side preview close enough for the conversation list
// to read with a single query instead of fanning out to every DO.
export async function writeConversationPreview(
  env: Env,
  conversationId: string,
  patch: { lastMessageAt: number; lastMessagePreview: string; lastMessageSender: string; lastSeq: number },
): Promise<void> {
  const db = getDb(env);
  await db.update(conversations).set(patch).where(eq(conversations.id, conversationId));
}
