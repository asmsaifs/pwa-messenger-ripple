import { Hono } from 'hono';
import { AppError, notFound } from '../errors';
import { createAuth } from '../lib/auth';
import { requireAuth } from '../middleware/actor';
import { userStub } from '../lib/user-do';
import { ALLOWED_MIME_TYPES, sniffMimeType } from '../lib/magic-bytes';
import { presignPutUrl } from '../lib/r2-presign';
import * as policy from '../policy';
import * as profilesRepo from '../repos/profiles';
import { takeRateLimit } from '../lib/rate-limit';
import { uuidv7 } from '../../shared/id';
import {
  completeAvatarInputSchema,
  meResponseSchema,
  signAvatarInputSchema,
  signAvatarResponseSchema,
  updateMeSchema,
} from '../../shared/me';
import { sessionsResponseSchema } from '../../shared/account';
import type { Env } from '../env';
import type { AuthUser } from '../middleware/actor';
import type { Actor } from '../types';

export const meRoute = new Hono<{
  Bindings: Env;
  Variables: { actor: Actor; authUser: AuthUser };
}>();

meRoute.use('*', requireAuth);

meRoute.get('/', async (c) => {
  const actor = c.get('actor');
  const authUser = c.get('authUser');
  await policy.assertProfileReadable(c.env, actor, actor.userId);

  const [profile, unreadTotal] = await Promise.all([
    profilesRepo.getProfile(c.env, actor, actor.userId),
    userStub(c.env, actor.userId).unreadTotal(),
  ]);
  if (!profile) throw new Error('profile missing for authenticated user'); // bootstrapped on signup — should never happen

  const body = meResponseSchema.parse({
    user: { id: authUser.id, email: authUser.email, emailVerified: actor.emailVerified },
    profile: {
      userId: profile.userId,
      displayName: profile.displayName,
      avatarKey: profile.avatarKey,
      statusText: profile.statusText,
    },
    unreadTotal,
  });
  return c.json(body);
});

// docs/05 §8 doesn't list a profile-update cap explicitly — this stops
// scripted rename/status spam without getting in the way of a real user
// editing their profile a few times in a row.
const PROFILE_UPDATE_HOURLY_LIMIT = 20;

meRoute.patch('/', async (c) => {
  const actor = c.get('actor');
  policy.assertProfileUpdatable(actor, actor.userId);
  await takeRateLimit(
    c.env,
    actor.userId,
    'profile-update',
    PROFILE_UPDATE_HOURLY_LIMIT,
    60 * 60 * 1000,
  );

  const patch = updateMeSchema.parse(await c.req.json());
  const profile =
    Object.keys(patch).length > 0
      ? await profilesRepo.updateProfile(c.env, actor, patch)
      : await profilesRepo.getProfile(c.env, actor, actor.userId);
  if (!profile) throw new Error('profile missing for authenticated user');

  const body = meResponseSchema.shape.profile.parse({
    userId: profile.userId,
    displayName: profile.displayName,
    avatarKey: profile.avatarKey,
    statusText: profile.statusText,
  });
  return c.json(body);
});

// Extension is cosmetic only, same rationale as attachments.ts's map — image
// types only here (an avatar is never a pdf/zip/etc).
const AVATAR_EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const AVATAR_UPLOAD_HOURLY_LIMIT = 10;

meRoute.post('/avatar/sign', async (c) => {
  const actor = c.get('actor');
  policy.assertProfileUpdatable(actor, actor.userId);
  await takeRateLimit(
    c.env,
    actor.userId,
    'avatar-upload',
    AVATAR_UPLOAD_HOURLY_LIMIT,
    60 * 60 * 1000,
  );

  const input = signAvatarInputSchema.parse(await c.req.json());
  const contentType = (input.contentType.split(';')[0] ?? input.contentType).trim();
  const ext = AVATAR_EXT_BY_CONTENT_TYPE[contentType];
  if (!ext) throw new AppError('upload/unsupported-type');

  const key = `avatars/${actor.userId}/${uuidv7()}.${ext}`;
  const { url, expiresAt } = await presignPutUrl(c.env, key, input.size);
  return c.json(signAvatarResponseSchema.parse({ uploadUrl: url, key, expiresAt }));
});

meRoute.post('/avatar/complete', async (c) => {
  const actor = c.get('actor');
  policy.assertProfileUpdatable(actor, actor.userId);

  const { key } = completeAvatarInputSchema.parse(await c.req.json());
  // The key a client claims to have uploaded must actually be one this actor
  // was signed for — never trust it blindly (CLAUDE.md hard rule 3: repos/
  // routes re-check authorization themselves, not just the identity of the
  // caller from `/sign`).
  if (!key.startsWith(`avatars/${actor.userId}/`)) throw new AppError('policy/forbidden');

  async function fail(): Promise<never> {
    await c.env.MEDIA.delete(key);
    throw new AppError('upload/mismatch');
  }

  const object = await c.env.MEDIA.head(key);
  if (!object) return fail();

  const range = await c.env.MEDIA.get(key, { range: { offset: 0, length: 4096 } });
  if (!range) return fail();
  const head = new Uint8Array(await range.arrayBuffer());
  const sniffed = sniffMimeType(head);
  if (!sniffed || !sniffed.startsWith('image/') || !ALLOWED_MIME_TYPES.has(sniffed)) return fail();

  const previous = await profilesRepo.getProfile(c.env, actor, actor.userId);
  const profile = await profilesRepo.updateProfile(c.env, actor, { avatarKey: key });
  if (!profile) throw new Error('profile missing for authenticated user');

  // Old avatar object is now unreferenced — clean it up so storage doesn't
  // grow unbounded across repeated re-uploads (mirrors attachments' orphan
  // sweep, just done inline here since there's at most one old key to drop).
  if (previous?.avatarKey && previous.avatarKey !== key) {
    await c.env.MEDIA.delete(previous.avatarKey);
  }

  const body = meResponseSchema.shape.profile.parse({
    userId: profile.userId,
    displayName: profile.displayName,
    avatarKey: profile.avatarKey,
    statusText: profile.statusText,
  });
  return c.json(body);
});

// Devices (docs/04 §"Settings"): Better Auth's `session` rows are the
// closest thing this app has to a device list — `listSessions` is inherently
// self-scoped (derived from the request's own session headers, no userId
// param exists to ask for someone else's), so there's no cross-user read to
// guard against here.
meRoute.get('/sessions', async (c) => {
  const actor = c.get('actor');
  const auth = createAuth(c.env);
  const sessions = await auth.api.listSessions({ headers: c.req.raw.headers });

  const body = sessionsResponseSchema.parse({
    sessions: sessions.map((s) => ({
      id: s.id,
      userAgent: s.userAgent ?? null,
      ipAddress: s.ipAddress ?? null,
      // Better Auth types `createdAt` as `Date`, but sessions round-trip
      // through the KV secondary storage as JSON, so at runtime it's really
      // a string — `new Date(...)` accepts a Date, string, or number alike.
      createdAt: new Date(s.createdAt).getTime(),
      current: s.id === actor.sessionId,
    })),
  });
  return c.json(body);
});

meRoute.delete('/sessions/:id', async (c) => {
  const actor = c.get('actor');
  const id = c.req.param('id');
  const auth = createAuth(c.env);
  const sessions = await auth.api.listSessions({ headers: c.req.raw.headers });
  const target = sessions.find((s) => s.id === id);
  if (!target) notFound();
  policy.assertSessionRevocable(actor, target.userId);

  await auth.api.revokeSession({ body: { token: target.token }, headers: c.req.raw.headers });
  return c.body(null, 204);
});
