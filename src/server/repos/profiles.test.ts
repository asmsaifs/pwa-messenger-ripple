import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from './db';
import { createProfile, getProfile, updateProfile } from './profiles';
import { user } from './schema';

describe('profiles repo', () => {
  beforeEach(async () => {
    const db = getDb(env);
    const now = Date.now();
    await db.insert(user).values({
      id: 'usr_a',
      name: 'A',
      email: 'a@example.com',
      emailVerified: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(user).values({
      id: 'usr_b',
      name: 'B',
      email: 'b@example.com',
      emailVerified: 1,
      createdAt: now,
      updatedAt: now,
    });
  });

  it('creates and reads back a profile', async () => {
    const actor = { userId: 'usr_a', sessionId: 's', emailVerified: true };
    await createProfile(env, actor, { displayName: 'Alice' });
    const row = await getProfile(env, actor, 'usr_a');
    expect(row?.displayName).toBe('Alice');
  });

  it('rejects an empty display name via the D1 CHECK constraint', async () => {
    const actor = { userId: 'usr_a', sessionId: 's', emailVerified: true };
    await expect(createProfile(env, actor, { displayName: '' })).rejects.toThrow();
  });

  it("update only ever touches the caller's own row", async () => {
    const actorA = { userId: 'usr_a', sessionId: 's', emailVerified: true };
    const actorB = { userId: 'usr_b', sessionId: 's', emailVerified: true };
    await createProfile(env, actorA, { displayName: 'Alice' });
    await createProfile(env, actorB, { displayName: 'Bob' });

    await updateProfile(env, actorA, { statusText: 'hi from A' });

    const a = await getProfile(env, actorA, 'usr_a');
    const b = await getProfile(env, actorB, 'usr_b');
    expect(a?.statusText).toBe('hi from A');
    expect(b?.statusText).toBeNull();
  });
});
