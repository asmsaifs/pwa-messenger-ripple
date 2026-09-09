import { getDb } from './db';
import { profiles, user } from './schema';
import type { Env } from '../env';

// Seeds the A/B/C/D fixture docs/07 §2 uses for the policy suite (M2), reused
// here so repo tests exercise the same shapes: A and B are friends already
// (created via a direct insert, not through the repo, to isolate what each
// test is actually exercising), C is an unrelated stranger.
export async function seedUsers(env: Env) {
  const db = getDb(env);
  const now = Date.now();
  const ids = ['usr_a', 'usr_b', 'usr_c', 'usr_d'] as const;
  for (const id of ids) {
    await db.insert(user).values({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(profiles).values({ userId: id, displayName: id, createdAt: now });
  }
  return { userA: 'usr_a', userB: 'usr_b', userC: 'usr_c', userD: 'usr_d' };
}
