import { getDb } from './db';
import {
  conversationMembers,
  conversations,
  friendships,
  profiles,
  user,
} from './schema';
import { uuidv7 } from '../../shared/id';
import type { Env } from '../env';
import type { Actor } from '../types';

// Seeds the A/B/C/D/E fixture docs/07 §2 uses for the policy suite (M2): A and
// B end up friends, C is an unrelated stranger, D is blocked by A, E is
// unverified. Direct inserts, not the repos, so each test isolates what it's
// actually exercising.
export async function seedUsers(env: Env) {
  const db = getDb(env);
  const now = Date.now();
  const ids = ['usr_a', 'usr_b', 'usr_c', 'usr_d', 'usr_e'] as const;
  for (const id of ids) {
    await db.insert(user).values({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: id === 'usr_e' ? 0 : 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(profiles).values({ userId: id, displayName: id, createdAt: now });
  }
  return {
    userA: 'usr_a',
    userB: 'usr_b',
    userC: 'usr_c',
    userD: 'usr_d',
    userE: 'usr_e',
  };
}

function actorFor(userId: string, emailVerified: boolean): Actor {
  return { userId, sessionId: 's', emailVerified };
}

// Full graph the policy suite (docs/07 §2) runs against: A+B accepted friends
// with a conversation, A+D blocked friends with a (still-existing) conversation,
// C a stranger, E unverified. Returns Actor helpers so tests don't hand-roll
// `{ userId, sessionId, emailVerified }`.
export async function seedFriendGraph(env: Env) {
  const { userA, userB, userC, userD, userE } = await seedUsers(env);
  const db = getDb(env);
  const now = Date.now();

  const friendshipId = uuidv7();
  const blockedFriendshipId = uuidv7();
  await db.batch([
    db.insert(friendships).values({
      id: friendshipId,
      userA,
      userB,
      requestedBy: userA,
      status: 'accepted',
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(friendships).values({
      id: blockedFriendshipId,
      ...(userA < userD ? { userA, userB: userD } : { userA: userD, userB: userA }),
      requestedBy: userA,
      blockedBy: userA,
      status: 'blocked',
      createdAt: now,
      updatedAt: now,
    }),
  ]);

  const conversationId = uuidv7();
  const blockedConversationId = uuidv7();
  await db.batch([
    db.insert(conversations).values({ id: conversationId, friendshipId, createdAt: now }),
    db.insert(conversationMembers).values({ conversationId, userId: userA }),
    db.insert(conversationMembers).values({ conversationId, userId: userB }),
    db.insert(conversations).values({
      id: blockedConversationId,
      friendshipId: blockedFriendshipId,
      createdAt: now,
    }),
    db.insert(conversationMembers).values({
      conversationId: blockedConversationId,
      userId: userA,
    }),
    db.insert(conversationMembers).values({
      conversationId: blockedConversationId,
      userId: userD,
    }),
  ]);

  return {
    userA,
    userB,
    userC,
    userD,
    userE,
    friendshipId,
    conversationId,
    blockedConversationId,
    actorA: actorFor(userA, true),
    actorB: actorFor(userB, true),
    actorC: actorFor(userC, true),
    actorD: actorFor(userD, true),
    actorE: actorFor(userE, false),
  };
}
