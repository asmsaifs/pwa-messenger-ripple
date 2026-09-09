// THE authorization module (docs/01 §5, docs/02 §5). D1 has no RLS — this is
// the only line of defense (CLAUDE.md hard rule 1). Every exported function
// here has an allow test and a deny test in `index.test.ts` (docs/07 §2).
//
// Rules this file follows:
// - Never imports drizzle or touches `env.DB` directly — only repos/* do that
//   (enforced by the same eslint layering rule as routes/DOs).
// - "Not visible to you" is always `policy/not-found`, never `policy/forbidden`
//   (docs/02 §5 enumeration rule) — the one exception is the blocked case
//   *inside* a conversation the actor is already a member of, which is
//   `policy/blocked` because membership already proved the row's existence.
// - Rate limiting (RateLimiterDO, M5) is enforced by callers (routes), not
//   here — an allow from a function in this file is never itself a
//   rate-limit pass. See src/server/lib/rate-limit.ts and
//   src/server/routes/friends.ts's `/invite` handler.
import { AppError, blocked, forbidden, notFound } from '../errors';
import * as attachmentsRepo from '../repos/attachments';
import * as callsRepo from '../repos/calls';
import * as conversationsRepo from '../repos/conversations';
import * as friendsRepo from '../repos/friends';
import * as profilesRepo from '../repos/profiles';
import type { Env } from '../env';
import type { Actor } from '../types';

function assertVerifiedEmail(actor: Actor): void {
  if (!actor.emailVerified) throw new AppError('auth/unverified-email');
}

function assertSelf(actor: Actor, userId: string): void {
  if (actor.userId !== userId) forbidden();
}

// ── Profiles ────────────────────────────────────────────────────────────
export async function assertProfileReadable(
  env: Env,
  actor: Actor,
  targetUserId: string,
) {
  if (actor.userId === targetUserId) return;
  await assertFriends(env, actor, targetUserId);
}

export function assertProfileUpdatable(actor: Actor, targetUserId: string) {
  assertSelf(actor, targetUserId);
}

// ── Friendships ─────────────────────────────────────────────────────────
// True only for an accepted, unblocked friendship — the shared building
// block for both profile visibility and "friends only" gates elsewhere.
// Throws `policy/not-found` for anything else (stranger, pending, blocked),
// matching the enumeration rule.
export async function assertFriends(env: Env, actor: Actor, otherUserId: string) {
  const friendship = await friendsRepo.getFriendshipWith(env, actor, otherUserId);
  if (!friendship || friendship.status !== 'accepted') notFound();
}

export async function assertCanCreateFriendship(
  env: Env,
  actor: Actor,
  targetUserId: string,
) {
  if (targetUserId === actor.userId) forbidden('cannot friend yourself');
  const existing = await friendsRepo.getFriendshipWith(env, actor, targetUserId);
  if (existing && (existing.status === 'accepted' || existing.status === 'blocked')) {
    forbidden('friendship already exists');
  }
}

async function loadFriendshipForMember(env: Env, actor: Actor, friendshipId: string) {
  const friendship = await friendsRepo.getFriendshipById(env, friendshipId);
  if (
    !friendship ||
    (friendship.userA !== actor.userId && friendship.userB !== actor.userId)
  ) {
    notFound();
  }
  return friendship;
}

export async function assertCanRespondToFriendship(
  env: Env,
  actor: Actor,
  friendshipId: string,
) {
  const friendship = await loadFriendshipForMember(env, actor, friendshipId);
  if (friendship.requestedBy === actor.userId)
    forbidden('requester cannot respond to own request');
  return friendship;
}

export async function assertCanBlockFriendship(
  env: Env,
  actor: Actor,
  friendshipId: string,
) {
  return loadFriendshipForMember(env, actor, friendshipId);
}

export async function assertCanUnblockFriendship(
  env: Env,
  actor: Actor,
  friendshipId: string,
) {
  const friendship = await loadFriendshipForMember(env, actor, friendshipId);
  if (friendship.blockedBy !== actor.userId) forbidden('only the blocker may unblock');
  return friendship;
}

// Withdraw/reject a request (docs/03 `DELETE /api/friends/:id`) — a member
// may cancel it while it's still pending, but not once it's been accepted;
// leaving an accepted friendship goes through block instead (docs/02 §5 has
// no separate "unfriend" row — block is the one exit path once accepted).
export async function assertCanDeleteFriendship(
  env: Env,
  actor: Actor,
  friendshipId: string,
) {
  const friendship = await loadFriendshipForMember(env, actor, friendshipId);
  if (friendship.status === 'accepted') {
    forbidden('use block to leave an accepted friendship');
  }
  return friendship;
}

// ── Invitations ─────────────────────────────────────────────────────────
export function assertCanInviteByEmail(actor: Actor) {
  assertVerifiedEmail(actor);
}

// Claiming completes the invite side of docs/03 "Auth" (§ signup ?invite=)
// — the invitee must also clear the verified-email gate every other
// invite/message/call action requires (docs/05 §2).
export function assertCanClaimInvitation(actor: Actor) {
  assertVerifiedEmail(actor);
}

// Resend/revoke (docs/03 `POST /api/invites/:id/resend`, `DELETE
// /api/invites/:id`) are inviter-only — enumeration rule applies the same as
// everywhere else: anyone else's invitation id is `policy/not-found`.
export async function assertCanManageInvitation(
  env: Env,
  actor: Actor,
  invitationId: string,
) {
  const invitation = await friendsRepo.getInvitationById(env, invitationId);
  if (!invitation || invitation.inviterId !== actor.userId) notFound();
  return invitation;
}

// ── Conversations ───────────────────────────────────────────────────────
// Returns the conversation row itself — for a 1:1 conversation, successfully
// loading it scoped to `actor` via conversation_members *is* the membership
// proof, so there's no separate Membership type to thread through.
export async function assertConversationMember(
  env: Env,
  actor: Actor,
  conversationId: string,
) {
  const conversation = await conversationsRepo.getConversation(
    env,
    actor,
    conversationId,
  );
  if (!conversation) notFound();
  return conversation;
}

export function assertCanSetReadMarker() {
  // Repo scopes the write to the actor's own conversation_members row and
  // rejects a regression via `last_read_seq` only increasing (docs/02 §5) —
  // membership is re-checked there, so this is a no-op placeholder that keeps
  // the "every route imports policy" convention uniform.
}

export async function assertCanSendMessage(
  env: Env,
  actor: Actor,
  conversationId: string,
) {
  assertVerifiedEmail(actor);
  await assertConversationMember(env, actor, conversationId);
  const friendship = await conversationsRepo.getConversationFriendship(
    env,
    conversationId,
  );
  if (!friendship) notFound();
  if (friendship.status === 'blocked') blocked();
  if (friendship.status !== 'accepted') forbidden('friendship is not accepted');
}

export function assertCanEditOrDeleteMessage(actor: Actor, senderId: string) {
  if (actor.userId !== senderId) forbidden();
}

// ── Attachments ─────────────────────────────────────────────────────────
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const STORAGE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

export async function assertCanSignAttachmentUpload(
  env: Env,
  actor: Actor,
  conversationId: string,
  byteSize: number,
) {
  await assertConversationMember(env, actor, conversationId);
  if (byteSize <= 0 || byteSize > MAX_ATTACHMENT_BYTES) {
    throw new AppError('upload/too-large');
  }
  const profile = await profilesRepo.getProfile(env, actor, actor.userId);
  if (!profile) notFound();
  if (profile.storageUsed + byteSize > STORAGE_QUOTA_BYTES) {
    throw new AppError('upload/quota');
  }
}

export async function assertAttachmentReadable(
  env: Env,
  actor: Actor,
  attachmentId: string,
) {
  const attachment = await attachmentsRepo.getAttachment(env, actor, attachmentId);
  if (!attachment) notFound();
  await assertConversationMember(env, actor, attachment.conversationId);
  if (attachment.status !== 'ready') notFound();
  return attachment;
}

// ── Calls ───────────────────────────────────────────────────────────────
export async function assertCanStartCall(
  env: Env,
  actor: Actor,
  conversationId: string,
  calleeId: string,
) {
  assertVerifiedEmail(actor);
  await assertConversationMember(env, actor, conversationId);
  const friendship = await conversationsRepo.getConversationFriendship(
    env,
    conversationId,
  );
  if (!friendship || friendship.status !== 'accepted') {
    if (friendship?.status === 'blocked') blocked();
    forbidden('friendship is not accepted');
  }
  if (await callsRepo.hasOpenCall(env, actor.userId)) {
    throw new AppError('call/busy');
  }
  void calleeId; // resolved from conversation membership, never trusted as-given by the caller
}

export async function assertCanActOnCall(env: Env, actor: Actor, callId: string) {
  const call = await callsRepo.getCall(env, actor, callId);
  if (!call) notFound();
  return call;
}

export const assertCanReadCallHistory = assertCanActOnCall;

// ── Push subscriptions ──────────────────────────────────────────────────
export function assertCanRegisterPushSub(actor: Actor, ownerId: string) {
  assertSelf(actor, ownerId);
}
