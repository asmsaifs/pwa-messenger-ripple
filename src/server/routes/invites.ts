import { Hono } from 'hono';
import { AppError } from '../errors';
import { requireAuth } from '../middleware/actor';
import * as policy from '../policy';
import * as friendsRepo from '../repos/friends';
import * as profilesRepo from '../repos/profiles';
import { sendInviteEmail } from '../lib/mail';
import { takeRateLimit } from '../lib/rate-limit';
import { generateInviteToken, hashInviteToken } from '../lib/tokens';
import {
  claimInvitationResponseSchema,
  invitePreviewResponseSchema,
} from '../../shared/invites';
import type { Env } from '../env';
import type { AuthUser } from '../middleware/actor';
import type { Actor } from '../types';

export const invitesRoute = new Hono<{
  Bindings: Env;
  Variables: { actor: Actor; authUser: AuthUser };
}>();

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const INVITE_EXPIRY_MS = 7 * ONE_DAY_MS;

// Preview and claim are reachable logged out (docs/04 §1 `/invite/:token`) —
// only resend/revoke, which act on the inviter's own row, need a session.
// `requireAuth` is applied per-route below rather than with `.use('*', ...)`.

invitesRoute.get('/:token', async (c) => {
  const token = c.req.param('token');
  const tokenHash = await hashInviteToken(token);
  const invitation = await friendsRepo.getInvitationByTokenHash(c.env, tokenHash);
  // Claimed, unknown, and expired all read as the same "not visible"
  // response (docs/02 §5 enumeration rule) — a stranger learns nothing about
  // which case they hit.
  if (!invitation || invitation.claimedBy || invitation.expiresAt < Date.now()) {
    throw new AppError('policy/not-found');
  }

  const inviterProfile = await profilesRepo.getProfile(
    c.env,
    { userId: invitation.inviterId, sessionId: 'system', emailVerified: true },
    invitation.inviterId,
  );
  const body = invitePreviewResponseSchema.parse({
    inviterName: inviterProfile?.displayName ?? 'Someone',
  });
  return c.json(body);
});

// Claim while already signed in (the invitee already had an account, or the
// signup+verify flow already redirected here — src/client/routes/ClaimInvitePage.tsx).
invitesRoute.post('/:token/claim', requireAuth, async (c) => {
  const actor = c.get('actor');
  policy.assertCanClaimInvitation(actor);
  const token = c.req.param('token');
  const tokenHash = await hashInviteToken(token);

  // Same enumeration rule as the preview route: claimed/expired/unknown all
  // read as not-found, and checking here (rather than only inside the repo,
  // which throws a bare Error for this) keeps that a taxonomy'd response.
  const existing = await friendsRepo.getInvitationByTokenHash(c.env, tokenHash);
  if (!existing || existing.claimedBy || existing.expiresAt < Date.now()) {
    throw new AppError('policy/not-found');
  }

  const { friendshipId, conversation } = await friendsRepo.claimInvitation(
    c.env,
    actor,
    tokenHash,
  );
  if (!conversation) throw new Error('claim did not produce a conversation');
  const body = claimInvitationResponseSchema.parse({
    friendshipId,
    conversationId: conversation.id,
  });
  return c.json(body);
});

invitesRoute.post('/:id/resend', requireAuth, async (c) => {
  const actor = c.get('actor');
  const authUser = c.get('authUser');
  const id = c.req.param('id');
  const invitation = await policy.assertCanManageInvitation(c.env, actor, id);
  if (invitation.claimedBy) throw new AppError('policy/not-found');
  await takeRateLimit(c.env, `invite:${id}`, 'resend', 1, ONE_DAY_MS);

  const rawToken = generateInviteToken();
  const tokenHash = await hashInviteToken(rawToken);
  const expiresAt = Date.now() + INVITE_EXPIRY_MS;
  await friendsRepo.rotateInvitationToken(c.env, id, { tokenHash, expiresAt });

  const url = `${c.env.APP_BASE_URL}/invite/${rawToken}`;
  await sendInviteEmail(c.env, { to: invitation.email, inviterName: authUser.name, url });
  return c.body(null, 204);
});

invitesRoute.delete('/:id', requireAuth, async (c) => {
  const actor = c.get('actor');
  const id = c.req.param('id');
  await policy.assertCanManageInvitation(c.env, actor, id);
  await friendsRepo.deleteInvitation(c.env, actor, id);
  return c.body(null, 204);
});
