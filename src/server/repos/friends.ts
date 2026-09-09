import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { getDb } from './db';
import {
  conversationMembers,
  conversations,
  friendships,
  invitations,
  profiles,
} from './schema';
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

export async function getFriendshipById(env: Env, friendshipId: string) {
  const db = getDb(env);
  return db.query.friendships.findFirst({ where: eq(friendships.id, friendshipId) });
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

// GET /api/friends needs a display name per row, not just the pair's user
// ids — batch-fetch the "other side"'s profile rather than joining per-row
// (friendship count per user is small; this stays a two-query op regardless).
export async function listFriendshipsWithProfiles(env: Env, actor: Actor) {
  const rows = await listFriendships(env, actor);
  const otherIds = rows.map((r) => (r.userA === actor.userId ? r.userB : r.userA));
  const db = getDb(env);
  const profileRows = otherIds.length
    ? await db.query.profiles.findMany({ where: inArray(profiles.userId, otherIds) })
    : [];
  const profileById = new Map(profileRows.map((p) => [p.userId, p]));
  return rows.map((friendship) => {
    const otherUserId = friendship.userA === actor.userId ? friendship.userB : friendship.userA;
    return { friendship, otherUserId, profile: profileById.get(otherUserId) };
  });
}

// Re-request after a decline: the pair keeps its one lifetime row (unique
// constraint on user_a/user_b, docs/02 §1), so a fresh request updates it
// back to pending rather than inserting a duplicate.
export async function reviveFriendshipRequest(env: Env, actor: Actor, friendshipId: string) {
  const db = getDb(env);
  const [row] = await db
    .update(friendships)
    .set({ status: 'pending', requestedBy: actor.userId, blockedBy: null, updatedAt: Date.now() })
    .where(eq(friendships.id, friendshipId))
    .returning();
  return row;
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

// Withdraw/reject a request that never got accepted (docs/03 `DELETE
// /api/friends/:id`). Never touches an accepted friendship — no conversation
// can exist yet for a non-accepted row, so this can't cascade-delete one
// (block/unblock, not delete, is the exit path for an accepted friendship).
export async function deleteFriendshipRow(env: Env, actor: Actor, friendshipId: string) {
  const db = getDb(env);
  const [row] = await db
    .delete(friendships)
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

export async function getInvitationById(env: Env, invitationId: string) {
  const db = getDb(env);
  return db.query.invitations.findFirst({ where: eq(invitations.id, invitationId) });
}

// Unclaimed invitations this actor sent, newest first — the "Invited" tab
// (docs/04 §2.6). Claimed ones move into `friendships`/`listFriendships`
// instead, so they're excluded here rather than shown twice.
export async function listInvitationsByInviter(env: Env, actor: Actor) {
  const db = getDb(env);
  return db.query.invitations.findMany({
    where: and(eq(invitations.inviterId, actor.userId), isNull(invitations.claimedBy)),
    orderBy: [desc(invitations.createdAt)],
  });
}

// Reused by invite-by-email so re-inviting the same unregistered address
// resends the existing link instead of minting a new token every time.
export async function getPendingInvitationByInviterAndEmail(
  env: Env,
  actor: Actor,
  email: string,
) {
  const db = getDb(env);
  return db.query.invitations.findFirst({
    where: and(
      eq(invitations.inviterId, actor.userId),
      eq(invitations.email, email),
      isNull(invitations.claimedBy),
      gt(invitations.expiresAt, Date.now()),
    ),
  });
}

// Resend (docs/03 `POST /api/invites/:id/resend`) mints a fresh token rather
// than re-sending the old one — the raw token is never stored (docs/02 §1),
// so by the time a resend is requested the original raw value is already
// gone; this is also strictly safer (old links stop working).
export async function rotateInvitationToken(
  env: Env,
  invitationId: string,
  input: { tokenHash: string; expiresAt: number },
) {
  const db = getDb(env);
  const [row] = await db
    .update(invitations)
    .set({ tokenHash: input.tokenHash, expiresAt: input.expiresAt })
    .where(eq(invitations.id, invitationId))
    .returning();
  return row;
}

// Revoke: scoped to the inviter's own rows in the WHERE clause, not trusted
// from the caller (docs/02 §5 "invite by email" is inviter-only for revoke).
export async function deleteInvitation(env: Env, actor: Actor, invitationId: string) {
  const db = getDb(env);
  const [row] = await db
    .delete(invitations)
    .where(and(eq(invitations.id, invitationId), eq(invitations.inviterId, actor.userId)))
    .returning();
  return row;
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
