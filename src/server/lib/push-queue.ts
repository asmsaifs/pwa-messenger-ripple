import { pushJobSchema, type PushPayload } from '../../shared/push';
import type { Env } from '../env';

// Producer side of `push-queue` (docs/03 §4, docs/01 §4.1/§4.4) — call sites
// are ConversationDO (after appending a message), friend routes (request/
// accept), and — once M13/M14 land — CallDO. Every producer already decided
// "this recipient has no live socket" (via UserDO.hasLiveSocket, docs/03 §3)
// before calling this; it does not re-check that itself.
export async function enqueuePush(
  env: Env,
  userId: string,
  payload: PushPayload,
  opts: { urgency: 'high' | 'normal'; ttl: number } = { urgency: 'normal', ttl: 60 * 60 * 24 },
): Promise<void> {
  const job = pushJobSchema.parse({ userId, payload, urgency: opts.urgency, ttl: opts.ttl });
  await env.PUSH_QUEUE.send(job);
}
