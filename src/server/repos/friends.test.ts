import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptFriendship,
  blockFriendship,
  createFriendshipRequest,
  getFriendshipWith,
  unblockFriendship,
} from './friends';
import { seedUsers } from './test-helpers';

describe('friends repo', () => {
  let userA: string, userB: string, userC: string;

  beforeEach(async () => {
    ({ userA, userB, userC } = await seedUsers(env));
  });

  it('stores one row per pair in canonical order regardless of request direction', async () => {
    const row = await createFriendshipRequest(
      env,
      { userId: userB, sessionId: 's', emailVerified: true },
      userA,
    );
    expect(row?.userA).toBe(userA);
    expect(row?.userB).toBe(userB);
    expect(row?.requestedBy).toBe(userB);

    const fromEitherSide = await getFriendshipWith(
      env,
      { userId: userA, sessionId: 's', emailVerified: true },
      userB,
    );
    expect(fromEitherSide?.id).toBe(row?.id);
  });

  it('rejects self-friending', async () => {
    await expect(
      createFriendshipRequest(
        env,
        { userId: userA, sessionId: 's', emailVerified: true },
        userA,
      ),
    ).rejects.toThrow();
  });

  it('the requester cannot accept their own request', async () => {
    const row = await createFriendshipRequest(
      env,
      { userId: userA, sessionId: 's', emailVerified: true },
      userB,
    );
    await expect(
      acceptFriendship(
        env,
        { userId: userA, sessionId: 's', emailVerified: true },
        row!.id,
      ),
    ).rejects.toThrow();
  });

  it('accepting creates a conversation with both members', async () => {
    const row = await createFriendshipRequest(
      env,
      { userId: userA, sessionId: 's', emailVerified: true },
      userB,
    );
    const { friendship, conversation } = await acceptFriendship(
      env,
      { userId: userB, sessionId: 's', emailVerified: true },
      row!.id,
    );
    expect(friendship.status).toBe('accepted');
    expect(conversation?.friendshipId).toBe(row!.id);
  });

  it('a stranger cannot accept a request between two other users', async () => {
    const row = await createFriendshipRequest(
      env,
      { userId: userA, sessionId: 's', emailVerified: true },
      userB,
    );
    await expect(
      acceptFriendship(
        env,
        { userId: userC, sessionId: 's', emailVerified: true },
        row!.id,
      ),
    ).rejects.toThrow();
  });

  it('only the blocker can unblock', async () => {
    const row = await createFriendshipRequest(
      env,
      { userId: userA, sessionId: 's', emailVerified: true },
      userB,
    );
    await acceptFriendship(
      env,
      { userId: userB, sessionId: 's', emailVerified: true },
      row!.id,
    );
    await blockFriendship(
      env,
      { userId: userA, sessionId: 's', emailVerified: true },
      row!.id,
    );

    const deniedAttempt = await unblockFriendship(
      env,
      { userId: userB, sessionId: 's', emailVerified: true },
      row!.id,
    );
    expect(deniedAttempt).toBeUndefined();

    const allowed = await unblockFriendship(
      env,
      { userId: userA, sessionId: 's', emailVerified: true },
      row!.id,
    );
    expect(allowed?.status).toBe('accepted');
  });
});
