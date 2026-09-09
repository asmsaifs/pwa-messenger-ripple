import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { findUserByEmail } from './users';
import { seedUsers } from './test-helpers';

describe('users repo', () => {
  beforeEach(async () => {
    await seedUsers(env);
  });

  it('finds a registered user by exact email', async () => {
    const found = await findUserByEmail(env, 'usr_a@example.com');
    expect(found?.id).toBe('usr_a');
  });

  it('returns undefined for an unregistered email', async () => {
    expect(await findUserByEmail(env, 'nobody@example.com')).toBeUndefined();
  });
});
