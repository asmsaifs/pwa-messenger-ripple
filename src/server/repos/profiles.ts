import { eq } from 'drizzle-orm';
import { getDb } from './db';
import { profiles } from './schema';
import type { Env } from '../env';
import type { Actor } from '../types';

export type CreateProfileInput = {
  displayName: string;
  avatarKey?: string;
  statusText?: string;
};

export type UpdateProfileInput = Partial<CreateProfileInput>;

// Bootstrap the 1:1 profile row for the caller's own account (docs/02 §1).
export async function createProfile(env: Env, actor: Actor, input: CreateProfileInput) {
  const db = getDb(env);
  const now = Date.now();
  const [row] = await db
    .insert(profiles)
    .values({
      userId: actor.userId,
      displayName: input.displayName,
      avatarKey: input.avatarKey,
      statusText: input.statusText,
      createdAt: now,
    })
    .returning();
  return row;
}

// Read is not self-scoped: docs/02 §5 allows self or an accepted-friend read.
// Callers must run `assertFriends` (M2) before calling this for anyone else.
export async function getProfile(env: Env, actor: Actor, userId: string) {
  void actor; // threaded through per the actor-first convention; policy check lands in M2
  const db = getDb(env);
  return db.query.profiles.findFirst({ where: eq(profiles.userId, userId) });
}

// Update is self-only (docs/02 §5) — enforced here, not deferred to policy,
// because "self only" needs no lookup: it re-checks by scoping the WHERE
// clause to the actor's own row rather than trusting a userId argument.
export async function updateProfile(env: Env, actor: Actor, patch: UpdateProfileInput) {
  const db = getDb(env);
  const [row] = await db
    .update(profiles)
    .set(patch)
    .where(eq(profiles.userId, actor.userId))
    .returning();
  return row;
}
