import { encryptPushPayload, vapidAuthorizationHeader, type PushSubscriptionKeys } from './vapid';
import * as pushRepo from '../repos/push';
import type { PushPayload } from '../../shared/push';
import type { Env } from '../env';

// Result of one delivery attempt against a push service endpoint (docs/03
// §4: "404/410 → delete the row. 429/5xx → message.retry()"). `ok` covers
// every other 2xx; anything else (e.g. a 400 from a malformed request) is
// logged and treated as a permanent failure — retrying it would just spin.
export type PushSendResult = 'ok' | 'gone' | 'retry' | 'failed';

// One HTTP POST to a Web Push endpoint, encrypted + VAPID-authorized per
// RFC 8291/8292 (src/server/lib/vapid.ts does the actual crypto — this is
// just the wire format around it). Never throws for an HTTP-level failure;
// callers branch on the returned `PushSendResult` instead (see
// src/server/push/consumer.ts), matching the endpoint-cleanup contract in
// docs/09 M12's exit criterion ("410 endpoints self-clean").
export async function sendWebPush(
  env: Env,
  subscription: PushSubscriptionKeys,
  payload: PushPayload,
  opts: { urgency: 'high' | 'normal'; ttl: number },
): Promise<PushSendResult> {
  const body = await encryptPushPayload(payload, subscription);
  const authorization = await vapidAuthorizationHeader(env, subscription.endpoint);

  let res: Response;
  try {
    res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        TTL: String(opts.ttl),
        Urgency: opts.urgency,
        Authorization: authorization,
      },
      body,
    });
  } catch (err) {
    console.error('push send: network error', err);
    return 'retry';
  }

  if (res.ok) return 'ok';
  if (res.status === 404 || res.status === 410) return 'gone';
  if (res.status === 429 || res.status >= 500) return 'retry';
  console.error('push send: permanent failure', res.status, await res.text().catch(() => ''));
  return 'failed';
}

// Delivers to every subscription for `userId` in parallel and self-cleans
// `gone` rows, mirroring src/server/push/consumer.ts's per-subscription
// handling. Used where a push must not wait behind `push-queue`'s
// max_batch_timeout (CallDO ring/cancel — a ring already has its own 30s TTL
// and RING_TIMEOUT alarm, so a queue's exponential retry backoff would just
// arrive after the call is over anyway). Fire-and-forget: callers already
// wrap this in try/catch and treat push delivery as best-effort.
export async function sendWebPushToUser(
  env: Env,
  userId: string,
  payload: PushPayload,
  opts: { urgency: 'high' | 'normal'; ttl: number },
): Promise<void> {
  const subscriptions = await pushRepo.listSubscriptionsForUserId(env, userId);
  await Promise.all(
    subscriptions.map(async (sub) => {
      const result = await sendWebPush(
        env,
        { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
        payload,
        opts,
      );
      if (result === 'ok') await pushRepo.markSubscriptionOk(env, sub.id);
      if (result === 'gone') await pushRepo.deleteSubscriptionById(env, sub.id);
    }),
  );
}
