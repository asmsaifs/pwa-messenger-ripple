import { and, eq } from 'drizzle-orm';
import { getDb } from './db';
import { pushSubscriptions } from './schema';
import { uuidv7 } from '../../shared/id';
import type { Env } from '../env';
import type { Actor } from '../types';

export type PushSubscriptionInput = {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
};

// register push sub: self only (docs/02 §5); endpoint uniqueness via upsert.
export async function upsertPushSubscription(
  env: Env,
  actor: Actor,
  input: PushSubscriptionInput,
) {
  const db = getDb(env);
  const now = Date.now();
  const [row] = await db
    .insert(pushSubscriptions)
    .values({
      id: uuidv7(),
      userId: actor.userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId: actor.userId,
        p256dh: input.p256dh,
        auth: input.auth,
        lastOkAt: now,
      },
    })
    .returning();
  return row;
}

export async function listSubscriptionsForUser(env: Env, actor: Actor) {
  const db = getDb(env);
  return db.query.pushSubscriptions.findMany({
    where: eq(pushSubscriptions.userId, actor.userId),
  });
}

export async function deleteSubscription(env: Env, actor: Actor, id: string) {
  const db = getDb(env);
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, actor.userId)));
}

// `DELETE /api/push/subscribe` (docs/03) identifies the row by `endpoint`,
// not the row id — the client only ever knows the endpoint the browser gave
// it (`PushSubscription.endpoint`), not our generated `id`. Still scoped to
// `actor.userId` (defense in depth per CLAUDE.md rule 3), matching
// `deleteSubscription`'s ownership check above.
export async function deleteSubscriptionByEndpoint(env: Env, actor: Actor, endpoint: string) {
  const db = getDb(env);
  await db
    .delete(pushSubscriptions)
    .where(
      and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, actor.userId)),
    );
}

// Non-actor: called from ConversationDO/UserDO fan-out (docs/03 §4's
// producers) and from the `push-queue` consumer, neither of which has a
// request-scoped `Actor` — same trust boundary as calls.ts's `getOpenCall`
// (the caller already resolved which userId to fan out to via membership/
// friendship, not from anything client-supplied).
export async function listSubscriptionsForUserId(env: Env, userId: string) {
  const db = getDb(env);
  return db.query.pushSubscriptions.findMany({
    where: eq(pushSubscriptions.userId, userId),
  });
}

// Consumer-side self-clean (docs/09 M12 exit criterion: "410 endpoints
// self-clean") — the consumer has already resolved the subscription row
// itself (via `listSubscriptionsForUserId`), so this only needs the row id,
// not an actor to re-check ownership against.
export async function deleteSubscriptionById(env: Env, id: string) {
  const db = getDb(env);
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
}

export async function markSubscriptionOk(env: Env, id: string) {
  const db = getDb(env);
  await db
    .update(pushSubscriptions)
    .set({ lastOkAt: Date.now() })
    .where(eq(pushSubscriptions.id, id));
}
