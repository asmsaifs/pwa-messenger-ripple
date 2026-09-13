import { sendWebPush } from '../lib/push-send';
import * as pushRepo from '../repos/push';
import { pushJobSchema } from '../../shared/push';
import type { Env } from '../env';

// `push-queue` consumer (docs/03 §4, docs/09 M12). Not under src/server/
// routes/ — the CI route-policy guard (scripts/check-policy-imports.sh) only
// walks that directory, and there's no authorization decision to make here:
// the producer already decided *which* userId to notify (via membership/
// friendship checks at the point the job was enqueued), so this only
// delivers to whatever subscriptions that userId currently has.
//
// Batch size 10 / max wait 5s / max_retries 3 / DLQ `push-dlq` are configured
// on the queue consumer binding in wrangler.jsonc, not here — Cloudflare
// moves a message to the DLQ automatically once `message.retry()` has been
// called `max_retries` times, so this file only decides ack-vs-retry per
// message, never DLQ placement itself.
export async function handlePushQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  // Each message's ack/retry is independent, so deliver the whole batch
  // concurrently — a slow/cold FCM round trip for one recipient must not
  // stall delivery to the next (was a sequential `for` loop, which under
  // load made batch delivery time scale linearly with recipient count).
  await Promise.all(
    batch.messages.map(async (message) => {
      try {
        await deliverOne(env, message.body);
        message.ack();
      } catch (err) {
        console.error('push-queue: delivery failed, retrying', err);
        message.retry();
      }
    }),
  );
}

// One job may fan out to several subscriptions (multiple devices/browsers
// for the same user). A `retry`-worthy failure on *any* subscription retries
// the whole job — docs/03 §4 specifies retry at message granularity, not
// per-subscription, and re-delivery is safe: `gone`/`ok` outcomes for the
// subscriptions that already succeeded are idempotent (the browser just
// shows the notification again, or the row is already deleted).
async function deliverOne(env: Env, rawBody: unknown): Promise<void> {
  const job = pushJobSchema.parse(rawBody);
  const subscriptions = await pushRepo.listSubscriptionsForUserId(env, job.userId);
  if (subscriptions.length === 0) return;

  // Multiple devices for the same user are independent subscriptions — send
  // to all of them concurrently rather than one at a time (was a sequential
  // `for` loop, adding real per-device latency to every message).
  const results = await Promise.all(
    subscriptions.map(async (sub) => {
      const result = await sendWebPush(
        env,
        { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
        job.payload,
        { urgency: job.urgency, ttl: job.ttl },
      );
      switch (result) {
        case 'ok':
          await pushRepo.markSubscriptionOk(env, sub.id);
          break;
        case 'gone':
          // docs/09 M12 exit criterion: "410 endpoints self-clean".
          await pushRepo.deleteSubscriptionById(env, sub.id);
          break;
        case 'retry':
          break;
        case 'failed':
          // Permanent (non-410) failure for this one subscription — logged by
          // sendWebPush already; don't let it fail the whole job.
          break;
      }
      return result;
    }),
  );
  if (results.includes('retry')) {
    throw new Error(`push-queue: ${job.userId} had a retryable delivery failure`);
  }
}
