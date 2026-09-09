import { Hono } from 'hono';
import { requireAuth } from '../middleware/actor';
import * as policy from '../policy';
import * as friendsRepo from '../repos/friends';
import * as profilesRepo from '../repos/profiles';
import * as usersRepo from '../repos/users';
import { sendInviteEmail } from '../lib/mail';
import { takeRateLimit } from '../lib/rate-limit';
import { generateInviteToken, hashInviteToken } from '../lib/tokens';
import { userStub } from '../lib/user-do';
import { userEventSchema, type PublicProfile } from '../../shared/user-events';
import {
  acceptFriendshipResponseSchema,
  friendsResponseSchema,
  inviteByEmailResponseSchema,
  inviteByEmailSchema,
} from '../../shared/friends';
import type { Env } from '../env';
import type { AuthUser } from '../middleware/actor';
import type { Actor } from '../types';

export const friendsRoute = new Hono<{
  Bindings: Env;
  Variables: { actor: Actor; authUser: AuthUser };
}>();

friendsRoute.use('*', requireAuth);

// `from`/`peer` on the UserDO `friend_request`/`friend_accepted` frames
// (docs/03 §2.2) so the recipient's UI can render the other side without a
// second round-trip to `/api/friends`.
async function publicProfileFor(env: Env, actor: Actor, userId: string): Promise<PublicProfile | undefined> {
  const profile = await profilesRepo.getProfile(env, actor, userId);
  if (!profile) return undefined;
  return {
    userId: profile.userId,
    displayName: profile.displayName,
    avatarKey: profile.avatarKey,
    statusText: profile.statusText,
  };
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const INVITE_EXPIRY_MS = 7 * ONE_DAY_MS;
const INVITE_DAILY_LIMIT = 10; // docs/05 §8, docs/09 M5 exit criteria

// Narrows a friendship+profile row down to ones whose profile actually
// resolved, without an `!` assertion at each call site below.
function hasProfile<T extends { profile: unknown }>(
  row: T,
): row is T & { profile: NonNullable<T['profile']> } {
  return row.profile != null;
}

friendsRoute.get('/', async (c) => {
  const actor = c.get('actor');
  const [rows, invitations] = await Promise.all([
    friendsRepo.listFriendshipsWithProfiles(c.env, actor),
    friendsRepo.listInvitationsByInviter(c.env, actor),
  ]);
  const withProfiles = rows.filter(hasProfile);

  const friends = withProfiles
    .filter((row) => row.friendship.status === 'accepted')
    .map((row) => ({
      friendshipId: row.friendship.id,
      userId: row.otherUserId,
      displayName: row.profile.displayName,
      avatarKey: row.profile.avatarKey,
      statusText: row.profile.statusText,
    }));

  const pending = withProfiles.filter((row) => row.friendship.status === 'pending');
  const incoming = pending
    .filter((row) => row.friendship.requestedBy !== actor.userId)
    .map((row) => ({
      friendshipId: row.friendship.id,
      userId: row.otherUserId,
      displayName: row.profile.displayName,
      avatarKey: row.profile.avatarKey,
      createdAt: row.friendship.createdAt,
    }));
  const outgoing = pending
    .filter((row) => row.friendship.requestedBy === actor.userId)
    .map((row) => ({
      friendshipId: row.friendship.id,
      userId: row.otherUserId,
      displayName: row.profile.displayName,
      avatarKey: row.profile.avatarKey,
      createdAt: row.friendship.createdAt,
    }));

  const body = friendsResponseSchema.parse({
    friends,
    incoming,
    outgoing,
    invitations: invitations.map((inv) => ({
      id: inv.id,
      email: inv.email,
      createdAt: inv.createdAt,
      expiresAt: inv.expiresAt,
    })),
  });
  return c.json(body);
});

// Single entry point for "add someone by email" — resolves to either a
// friend request (already registered) or an email invitation (docs/03).
friendsRoute.post('/invite', async (c) => {
  const actor = c.get('actor');
  const authUser = c.get('authUser');
  policy.assertCanInviteByEmail(actor);
  await takeRateLimit(c.env, actor.userId, 'invite', INVITE_DAILY_LIMIT, ONE_DAY_MS);

  const { email: rawEmail } = inviteByEmailSchema.parse(await c.req.json());
  const email = rawEmail.trim().toLowerCase();

  const targetUser = await usersRepo.findUserByEmail(c.env, email);
  if (targetUser && targetUser.id !== actor.userId) {
    await policy.assertCanCreateFriendship(c.env, actor, targetUser.id);
    const existing = await friendsRepo.getFriendshipWith(c.env, actor, targetUser.id);
    let friendship = existing;
    if (existing?.status === 'declined') {
      friendship = await friendsRepo.reviveFriendshipRequest(c.env, actor, existing.id);
    } else if (!existing) {
      friendship = await friendsRepo.createFriendshipRequest(c.env, actor, targetUser.id);
    }
    // an existing `pending` row means the request already stands — no new
    // notification, since the recipient already saw this one land once.
    if (friendship && friendship !== existing) {
      const from = await publicProfileFor(c.env, actor, actor.userId);
      if (from) {
        // `friendship.status` is drizzle's plain `text()` column type — the
        // zod parse both validates it against the real enum and narrows it
        // for the RPC call's TS type, the same value it already is at runtime.
        await userStub(c.env, targetUser.id).notify(
          userEventSchema.parse({ t: 'friend_request', friendship, from }),
        );
      }
    }
    return c.json(inviteByEmailResponseSchema.parse({ kind: 'request_sent' }));
  }

  // Not a registered user: mint (or rotate) an email invitation. Re-inviting
  // the same address reuses its row and rotates the token rather than
  // accumulating duplicate invitations.
  const existingInvitation = await friendsRepo.getPendingInvitationByInviterAndEmail(
    c.env,
    actor,
    email,
  );
  const rawToken = generateInviteToken();
  const tokenHash = await hashInviteToken(rawToken);
  const expiresAt = Date.now() + INVITE_EXPIRY_MS;
  const invitation = existingInvitation
    ? await friendsRepo.rotateInvitationToken(c.env, existingInvitation.id, {
        tokenHash,
        expiresAt,
      })
    : await friendsRepo.createInvitation(c.env, actor, { email, tokenHash, expiresAt });
  if (!invitation) throw new Error('invitation upsert returned no row');

  const url = `${c.env.APP_BASE_URL}/invite/${rawToken}`;
  await sendInviteEmail(c.env, { to: email, inviterName: authUser.name, url });

  return c.json(inviteByEmailResponseSchema.parse({ kind: 'email_sent' }));
});

friendsRoute.post('/:id/accept', async (c) => {
  const actor = c.get('actor');
  const id = c.req.param('id');
  const friendship = await policy.assertCanRespondToFriendship(c.env, actor, id);
  const { conversation } = await friendsRepo.acceptFriendship(c.env, actor, id);
  if (!conversation) throw new Error('accept did not produce a conversation');

  const peer = await publicProfileFor(c.env, actor, actor.userId);
  if (peer) {
    await userStub(c.env, friendship.requestedBy).notify({
      t: 'friend_accepted',
      conversationId: conversation.id,
      peer,
    });
  }

  return c.json(acceptFriendshipResponseSchema.parse({ conversationId: conversation.id }));
});

friendsRoute.post('/:id/decline', async (c) => {
  const actor = c.get('actor');
  const id = c.req.param('id');
  await policy.assertCanRespondToFriendship(c.env, actor, id);
  await friendsRepo.declineFriendship(c.env, actor, id);
  return c.body(null, 204);
});

friendsRoute.post('/:id/block', async (c) => {
  const actor = c.get('actor');
  const id = c.req.param('id');
  await policy.assertCanBlockFriendship(c.env, actor, id);
  await friendsRepo.blockFriendship(c.env, actor, id);
  return c.body(null, 204);
});

friendsRoute.post('/:id/unblock', async (c) => {
  const actor = c.get('actor');
  const id = c.req.param('id');
  await policy.assertCanUnblockFriendship(c.env, actor, id);
  await friendsRepo.unblockFriendship(c.env, actor, id);
  return c.body(null, 204);
});

friendsRoute.delete('/:id', async (c) => {
  const actor = c.get('actor');
  const id = c.req.param('id');
  await policy.assertCanDeleteFriendship(c.env, actor, id);
  await friendsRepo.deleteFriendshipRow(c.env, actor, id);
  return c.body(null, 204);
});
