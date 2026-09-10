import { z } from 'zod';

// Push subscription REST contract (docs/03 "Push & account") and the
// `push-queue` job shape (docs/03 §4) — imported by both the route/consumer
// (validation) and the client (types + parsing), same convention as every
// other src/shared module (CLAUDE.md rule 5).

// `PushSubscriptionJSON`'s shape from the browser (`pushManager.subscribe()`
// resolves a `PushSubscription`; `.toJSON()` gives exactly this).
export const pushSubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
export type PushSubscribeInput = z.infer<typeof pushSubscribeSchema>;

export const pushUnsubscribeSchema = z.object({ endpoint: z.string().url() });
export type PushUnsubscribeInput = z.infer<typeof pushUnsubscribeSchema>;

// ── `push-queue` job (docs/03 §4, verbatim) ────────────────────────────────
export const pushPayloadTypeSchema = z.enum([
  'message',
  'friend_request',
  'friend_accepted',
  'call',
  'call_cancelled',
  'export_ready',
]);
export type PushPayloadType = z.infer<typeof pushPayloadTypeSchema>;

export const pushPayloadSchema = z.object({
  type: pushPayloadTypeSchema,
  title: z.string(),
  body: z.string(),
  tag: z.string(),
  data: z.object({ url: z.string() }),
});
export type PushPayload = z.infer<typeof pushPayloadSchema>;

export const pushJobSchema = z.object({
  userId: z.string(),
  payload: pushPayloadSchema,
  urgency: z.enum(['high', 'normal']),
  ttl: z.number().int().nonnegative(),
});
export type PushJob = z.infer<typeof pushJobSchema>;
