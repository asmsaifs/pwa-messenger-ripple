import { Hono } from 'hono';
import { requireAuth } from '../middleware/actor';
import * as policy from '../policy';
import type { Env } from '../env';
import type { AuthUser } from '../middleware/actor';
import type { Actor } from '../types';

export const wsRoute = new Hono<{
  Bindings: Env;
  Variables: { actor: Actor; authUser: AuthUser };
}>();

wsRoute.use('*', requireAuth);

// GET /api/ws/conversation/:id — authenticates via cookie, re-checks
// membership (docs/03 §2), then forwards the upgrade to the DO. `actorUserId`
// travels as a query param on the *forwarded* request only — the DO trusts it
// because nothing but this route (already past `requireAuth` +
// `assertConversationMember`) can reach it (docs/01 §5); after the upgrade,
// the DO pins identity into `ws.serializeAttachment` and never reads it from
// a frame body again.
wsRoute.get('/conversation/:id', async (c) => {
  const actor = c.get('actor');
  const id = c.req.param('id');
  await policy.assertConversationMember(c.env, actor, id);

  const forwardedUrl = new URL(c.req.url);
  forwardedUrl.searchParams.set('actorUserId', actor.userId);
  const forwarded = new Request(forwardedUrl, c.req.raw);

  const stub = c.env.CONVERSATION.get(c.env.CONVERSATION.idFromName(id));
  return stub.fetch(forwarded);
});

// GET /api/ws/user — the personal socket (docs/01 §6, docs/03 §2.2), one per
// device, open for the whole session. Always self-scoped (no `:id` param, no
// separate policy assertion): `requireAuth` already proved who `actor` is,
// and that's the only identity this socket ever represents.
wsRoute.get('/user', async (c) => {
  const actor = c.get('actor');

  const forwardedUrl = new URL(c.req.url);
  forwardedUrl.searchParams.set('actorUserId', actor.userId);
  const forwarded = new Request(forwardedUrl, c.req.raw);

  const stub = c.env.USER.get(c.env.USER.idFromName(actor.userId));
  return stub.fetch(forwarded);
});
