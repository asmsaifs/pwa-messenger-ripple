import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { acceptFriendship, createFriendshipRequest } from './friends';
import { getConversation, setLastReadSeq } from './conversations';
import { seedUsers } from './test-helpers';

describe('conversations repo', () => {
  let userA: string, userB: string, userC: string, conversationId: string;

  beforeEach(async () => {
    ({ userA, userB, userC } = await seedUsers(env));
    const request = await createFriendshipRequest(
      env,
      { userId: userA, sessionId: 's', emailVerified: true },
      userB,
    );
    const { conversation } = await acceptFriendship(
      env,
      { userId: userB, sessionId: 's', emailVerified: true },
      request!.id,
    );
    conversationId = conversation!.id;
  });

  it('returns the conversation for a member', async () => {
    const row = await getConversation(
      env,
      { userId: userA, sessionId: 's', emailVerified: true },
      conversationId,
    );
    expect(row?.id).toBe(conversationId);
  });

  it('returns undefined for a non-member — never leaks existence', async () => {
    const row = await getConversation(
      env,
      { userId: userC, sessionId: 's', emailVerified: true },
      conversationId,
    );
    expect(row).toBeUndefined();
  });

  it('last_read_seq only moves forward', async () => {
    await setLastReadSeq(
      env,
      { userId: userA, sessionId: 's', emailVerified: true },
      conversationId,
      5,
    );
    const stale = await setLastReadSeq(
      env,
      { userId: userA, sessionId: 's', emailVerified: true },
      conversationId,
      2,
    );
    expect(stale).toBeUndefined();

    const advanced = await setLastReadSeq(
      env,
      { userId: userA, sessionId: 's', emailVerified: true },
      conversationId,
      9,
    );
    expect(advanced?.lastReadSeq).toBe(9);
  });
});
