import { Hono } from 'hono';
import { notFound } from '../errors';
import { createAuth } from '../lib/auth';
import { requireAuth } from '../middleware/actor';
import { userStub } from '../lib/user-do';
import * as policy from '../policy';
import * as profilesRepo from '../repos/profiles';
import { takeRateLimit } from '../lib/rate-limit';
import { meResponseSchema, updateMeSchema } from '../../shared/me';
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
      createdAt: s.createdAt.getTime(),
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
