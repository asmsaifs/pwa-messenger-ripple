import { and, eq, or } from 'drizzle-orm';
import { getDb } from './db';
import { conversationMembers, conversations, friendships, invitations } from './schema';
import { uuidv7 } from '../../shared/id';
import type { Env } from '../env';
import type { Actor } from '../types';

// Friendship rows are stored once per pair in canonical order (docs/02 §1) —
// callers never need to know which side is "a" or "b".
function canonicalPair(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

export async function createFriendshipRequest(
  env: Env,
  actor: Actor,
  targetUserId: string,
) {
  if (targetUserId === actor.userId) {
    throw new Error('cannot friend yourself');
  }
  const db = getDb(env);
  const [userA, userB] = canonicalPair(actor.userId, targetUserId);
  const now = Date.now();
  const [row] = await db
    .insert(friendships)
    .values({
      id: uuidv7(),
      userA,
      userB,
      requestedBy: actor.userId,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row;
}

export async function getFriendshipWith(env: Env, actor: Actor, otherUserId: string) {
  const db = getDb(env);
  const [userA, userB] = canonicalPair(actor.userId, otherUserId);
  return db.query.friendships.findFirst({
    where: and(eq(friendships.userA, userA), eq(friendships.userB, userB)),
  });
}

export async function listFriendships(env: Env, actor: Actor) {
  const db = getDb(env);
  return db.query.friendships.findMany({
    where: or(eq(friendships.userA, actor.userId), eq(friendships.userB, actor.userId)),
  });
}

// accept/decline: actor must be a member of the pair and not the requester
// (docs/02 §5) — re-checked here via the WHERE clause, not trusted from the caller.
export async function acceptFriendship(env: Env, actor: Actor, friendshipId: string) {
  const db = getDb(env);
  const [row] = await db
    .update(friendships)
    .set({ status: 'accepted', updatedAt: Date.now() })
    .where(
      and(
        eq(friendships.id, friendshipId),
        or(eq(friendships.userA, actor.userId), eq(friendships.userB, actor.userId)),
      ),
    )
    .returning();
  if (!row || row.requestedBy === actor.userId) {
    throw new Error('friendship not found or actor is the requester');
  }

  const friendshipConversation = await createConversationForFriendship(env, row.id, [
    row.userA,
    row.userB,
  ]);
  return { friendship: row, conversation: friendshipConversation };
}

export async function declineFriendship(env: Env, actor: Actor, friendshipId: string) {
  const db = getDb(env);
  const [row] = await db
    .update(friendships)
    .set({ status: 'declined', updatedAt: Date.now() })
    .where(
      and(
        eq(friendships.id, friendshipId),
        or(eq(friendships.userA, actor.userId), eq(friendships.userB, actor.userId)),
      ),
    )
    .returning();
  return row;
}

export async function blockFriendship(env: Env, actor: Actor, friendshipId: string) {
  const db = getDb(env);
  const [row] = await db
    .update(friendships)
    .set({ status: 'blocked', blockedBy: actor.userId, updatedAt: Date.now() })
    .where(
      and(
        eq(friendships.id, friendshipId),
        or(eq(friendships.userA, actor.userId), eq(friendships.userB, actor.userId)),
      ),
    )
    .returning();
  return row;
}

// unblock: only the user who set the block may lift it (docs/02 §5).
export async function unblockFriendship(env: Env, actor: Actor, friendshipId: string) {
  const db = getDb(env);
  const [row] = await db
    .update(friendships)
    .set({ status: 'accepted', blockedBy: null, updatedAt: Date.now() })
    .where(and(eq(friendships.id, friendshipId), eq(friendships.blockedBy, actor.userId)))
    .returning();
  return row;
}

export async function createInvitation(
  env: Env,
  actor: Actor,
  input: { email: string; tokenHash: string; expiresAt: number },
) {
  const db = getDb(env);
  const [row] = await db
    .insert(invitations)
    .values({
      id: uuidv7(),
      inviterId: actor.userId,
      email: input.email.trim().toLowerCase(),
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      createdAt: Date.now(),
    })
    .returning();
  return row;
}

export async function getInvitationByTokenHash(env: Env, tokenHash: string) {
  const db = getDb(env);
  return db.query.invitations.findFirst({ where: eq(invitations.tokenHash, tokenHash) });
}

// Claim on signup: mark the invitation used and create the accepted
// friendship + conversation in one D1 batch (docs/01 §4.4 step 3).
export async function claimInvitation(env: Env, actor: Actor, tokenHash: string) {
  const db = getDb(env);
  const invitation = await getInvitationByTokenHash(env, tokenHash);
  if (!invitation || invitation.claimedBy || invitation.expiresAt < Date.now()) {
    throw new Error('invitation not found, already claimed, or expired');
  }

  const now = Date.now();
  const friendshipId = uuidv7();
  const [userA, userB] = canonicalPair(invitation.inviterId, actor.userId);

  await db.batch([
    db
      .update(invitations)
      .set({ claimedBy: actor.userId, claimedAt: now })
      .where(eq(invitations.id, invitation.id)),
    db.insert(friendships).values({
      id: friendshipId,
      userA,
      userB,
      requestedBy: invitation.inviterId,
      status: 'accepted',
      createdAt: now,
      updatedAt: now,
    }),
  ]);

  const conversation = await createConversationForFriendship(env, friendshipId, [
    userA,
    userB,
  ]);
  return { friendshipId, conversation };
}

async function createConversationForFriendship(
  env: Env,
  friendshipId: string,
  memberIds: [string, string],
) {
  const db = getDb(env);
  const conversationId = uuidv7();
  const now = Date.now();
  await db.batch([
    db.insert(conversations).values({ id: conversationId, friendshipId, createdAt: now }),
    db.insert(conversationMembers).values({ conversationId, userId: memberIds[0] }),
    db.insert(conversationMembers).values({ conversationId, userId: memberIds[1] }),
  ]);
  return db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
}
