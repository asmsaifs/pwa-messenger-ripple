import { Hono } from 'hono';
import { requireAuth } from '../middleware/actor';
import * as policy from '../policy';
import * as profilesRepo from '../repos/profiles';
import { meResponseSchema, updateMeSchema } from '../../shared/me';
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

  const profile = await profilesRepo.getProfile(c.env, actor, actor.userId);
  if (!profile) throw new Error('profile missing for authenticated user'); // bootstrapped on signup — should never happen

  const body = meResponseSchema.parse({
    user: { id: authUser.id, email: authUser.email, emailVerified: actor.emailVerified },
    profile: {
      userId: profile.userId,
      displayName: profile.displayName,
      avatarKey: profile.avatarKey,
      statusText: profile.statusText,
    },
  });
  return c.json(body);
});

meRoute.patch('/', async (c) => {
  const actor = c.get('actor');
  policy.assertProfileUpdatable(actor, actor.userId);

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
