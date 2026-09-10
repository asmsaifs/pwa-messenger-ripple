import { Hono } from 'hono';
import { requireAuth } from '../middleware/actor';
import * as policy from '../policy';
import * as pushRepo from '../repos/push';
import { sendWebPush } from '../lib/push-send';
import { pushSubscribeSchema, pushUnsubscribeSchema } from '../../shared/push';
import type { Env } from '../env';
import type { AuthUser } from '../middleware/actor';
import type { Actor } from '../types';

export const pushRoute = new Hono<{
  Bindings: Env;
  Variables: { actor: Actor; authUser: AuthUser };
}>();

pushRoute.use('*', requireAuth);

// docs/03 "Push & account": `POST /api/push/subscribe { endpoint, keys:{p256dh,auth} } → 204`.
// Self-only (docs/02 §5 "register push sub"); endpoint uniqueness is handled
// by the repo's upsert (a subscription re-registering after a token rotation
// — `pushsubscriptionchange` — just overwrites its own row).
pushRoute.post('/subscribe', async (c) => {
  const actor = c.get('actor');
  policy.assertCanRegisterPushSub(actor, actor.userId);
  const input = pushSubscribeSchema.parse(await c.req.json());
  const userAgent = c.req.header('User-Agent');
  await pushRepo.upsertPushSubscription(c.env, actor, {
    endpoint: input.endpoint,
    p256dh: input.keys.p256dh,
    auth: input.keys.auth,
    // `exactOptionalPropertyTypes`: omit the key entirely rather than assign
    // `userAgent: undefined` (the repo's `PushSubscriptionInput.userAgent?`
    // means "may be absent", not "may be present-and-undefined").
    ...(userAgent !== undefined ? { userAgent } : {}),
  });
  return c.body(null, 204);
});

// `DELETE /api/push/subscribe { endpoint } → 204` — used both for an
// explicit "turn off notifications" and, from the client, right before
// re-subscribing on a `pushsubscriptionchange` event (docs/06 §3).
pushRoute.delete('/subscribe', async (c) => {
  const actor = c.get('actor');
  policy.assertCanRegisterPushSub(actor, actor.userId);
  const input = pushUnsubscribeSchema.parse(await c.req.json());
  await pushRepo.deleteSubscriptionByEndpoint(c.env, actor, input.endpoint);
  return c.body(null, 204);
});

// `POST /api/push/test → 204` (docs/03, docs/04 §"Notifications": "Test
// notification" in Settings). Sent synchronously, not via `push-queue` — a
// manual test action wants immediate feedback, not "somewhere in the next
// 5s batch window"; the queue's batching exists for fan-out volume this
// single-user, single-click action doesn't have.
pushRoute.post('/test', async (c) => {
  const actor = c.get('actor');
  policy.assertCanRegisterPushSub(actor, actor.userId);
  const subscriptions = await pushRepo.listSubscriptionsForUser(c.env, actor);
  await Promise.all(
    subscriptions.map(async (sub) => {
      const result = await sendWebPush(
        c.env,
        { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
        {
          type: 'message',
          title: 'Ripple',
          body: 'Test notification — push is working.',
          tag: 'push-test',
          data: { url: '/settings' },
        },
        { urgency: 'normal', ttl: 30 },
      );
      if (result === 'gone') await pushRepo.deleteSubscriptionById(c.env, sub.id);
      else if (result === 'ok') await pushRepo.markSubscriptionOk(c.env, sub.id);
    }),
  );
  return c.body(null, 204);
});
