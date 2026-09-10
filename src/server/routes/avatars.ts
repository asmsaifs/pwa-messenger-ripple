import { Hono } from 'hono';
import { requireAuth } from '../middleware/actor';
import * as policy from '../policy';
import type { Env } from '../env';
import type { AuthUser } from '../middleware/actor';
import type { Actor } from '../types';

// GET /avatars/:userId/:filename — src/sw.ts caches this pathname
// (StaleWhileRevalidate, cache name "avatars", also read/cleared by
// StorageSection). Served from a plain Worker route rather than a presigned
// R2 GET like attachments (attachments.ts's `/:id/url`) because the key
// itself already encodes the owning user — nothing to look up — and a stable
// unsigned path is what lets the SW cache it by URL at all.
export const avatarsRoute = new Hono<{
  Bindings: Env;
  Variables: { actor: Actor; authUser: AuthUser };
}>();

avatarsRoute.use('*', requireAuth);

avatarsRoute.get('/:userId/:filename', async (c) => {
  const actor = c.get('actor');
  const userId = c.req.param('userId');
  // Same visibility rule as the profile row this key came from (docs/02 §5):
  // self or an accepted friend, never a stranger.
  await policy.assertProfileReadable(c.env, actor, userId);

  const key = `avatars/${userId}/${c.req.param('filename')}`;
  const object = await c.env.MEDIA.get(key);
  if (!object) return c.notFound();

  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      // Filename is a fresh UUID per upload (never reused), so this object's
      // bytes never change under a given URL.
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
});
