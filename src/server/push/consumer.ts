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
  for (const message of batch.messages) {
    try {
      await deliverOne(env, message.body);
      message.ack();
    } catch (err) {
      console.error('push-queue: delivery failed, retrying', err);
      message.retry();
    }
  }
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

  let anyRetry = false;
  for (const sub of subscriptions) {
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
        anyRetry = true;
        break;
      case 'failed':
        // Permanent (non-410) failure for this one subscription — logged by
        // sendWebPush already; don't let it fail the whole job.
        break;
    }
  }
  if (anyRetry) throw new Error(`push-queue: ${job.userId} had a retryable delivery failure`);
}
