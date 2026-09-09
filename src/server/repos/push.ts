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
