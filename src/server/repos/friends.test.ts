import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptFriendship,
  blockFriendship,
  claimInvitation,
  createFriendshipRequest,
  createInvitation,
  declineFriendship,
  deleteFriendshipRow,
  deleteInvitation,
  getFriendshipWith,
  getInvitationByTokenHash,
  getPendingInvitationByInviterAndEmail,
  listFriendshipsWithProfiles,
  listInvitationsByInviter,
  reviveFriendshipRequest,
  rotateInvitationToken,
  unblockFriendship,
} from './friends';
import { seedUsers } from './test-helpers';

function actor(userId: string) {
  return { userId, sessionId: 's', emailVerified: true };
}

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

  it('listFriendshipsWithProfiles resolves the other side per row', async () => {
    const row = await createFriendshipRequest(env, actor(userA), userB);
    await acceptFriendship(env, actor(userB), row!.id);

    const rows = await listFriendshipsWithProfiles(env, actor(userA));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.otherUserId).toBe(userB);
    expect(rows[0]?.profile?.userId).toBe(userB);
  });

  it('reviving a declined request re-requests it as the reviving actor', async () => {
    const row = await createFriendshipRequest(env, actor(userA), userB);
    await declineFriendship(env, actor(userB), row!.id);

    const revived = await reviveFriendshipRequest(env, actor(userB), row!.id);
    expect(revived?.status).toBe('pending');
    expect(revived?.requestedBy).toBe(userB);
  });

  it('delete removes a pending row but is a no-op on someone else\'s pair', async () => {
    const row = await createFriendshipRequest(env, actor(userA), userB);
    const deniedAttempt = await deleteFriendshipRow(env, actor(userC), row!.id);
    expect(deniedAttempt).toBeUndefined();

    const deleted = await deleteFriendshipRow(env, actor(userA), row!.id);
    expect(deleted?.id).toBe(row!.id);
    expect(await getFriendshipWith(env, actor(userA), userB)).toBeUndefined();
  });
});

describe('invitations repo', () => {
  let userA: string, userB: string;

  beforeEach(async () => {
    ({ userA, userB } = await seedUsers(env));
  });

  it('claiming marks the invitation used and creates an accepted friendship + conversation', async () => {
    await createInvitation(env, actor(userA), {
      email: 'new@example.com',
      tokenHash: 'hash-1',
      expiresAt: Date.now() + 1_000,
    });

    const { friendshipId, conversation } = await claimInvitation(env, actor(userB), 'hash-1');
    expect(conversation?.friendshipId).toBe(friendshipId);

    const invitation = await getInvitationByTokenHash(env, 'hash-1');
    expect(invitation?.claimedBy).toBe(userB);
  });

  it('rejects claiming an expired invitation', async () => {
    await createInvitation(env, actor(userA), {
      email: 'new@example.com',
      tokenHash: 'hash-expired',
      expiresAt: Date.now() - 1_000,
    });
    await expect(claimInvitation(env, actor(userB), 'hash-expired')).rejects.toThrow();
  });

  it('rejects claiming an already-claimed invitation', async () => {
    await createInvitation(env, actor(userA), {
      email: 'new@example.com',
      tokenHash: 'hash-2',
      expiresAt: Date.now() + 1_000,
    });
    await claimInvitation(env, actor(userB), 'hash-2');
    await expect(claimInvitation(env, actor(userB), 'hash-2')).rejects.toThrow();
  });

  it('rotating a token changes the hash and expiry without a new row', async () => {
    const created = await createInvitation(env, actor(userA), {
      email: 'new@example.com',
      tokenHash: 'hash-3',
      expiresAt: Date.now() + 1_000,
    });
    const rotated = await rotateInvitationToken(env, created!.id, {
      tokenHash: 'hash-3-rotated',
      expiresAt: Date.now() + 2_000,
    });
    expect(rotated?.id).toBe(created!.id);
    expect(await getInvitationByTokenHash(env, 'hash-3')).toBeUndefined();
    expect((await getInvitationByTokenHash(env, 'hash-3-rotated'))?.id).toBe(created!.id);
  });

  it('lists only unclaimed invitations by inviter, newest first', async () => {
    await createInvitation(env, actor(userA), {
      email: 'first@example.com',
      tokenHash: 'hash-first',
      expiresAt: Date.now() + 1_000,
    });
    const second = await createInvitation(env, actor(userA), {
      email: 'second@example.com',
      tokenHash: 'hash-second',
      expiresAt: Date.now() + 1_000,
    });
    await claimInvitation(env, actor(userB), 'hash-second');

    const rows = await listInvitationsByInviter(env, actor(userA));
    expect(rows.map((r) => r.id)).not.toContain(second!.id);
    expect(rows.map((r) => r.email)).toContain('first@example.com');
  });

  it('finds a pending invitation to the same inviter+email, ignoring expired ones', async () => {
    await createInvitation(env, actor(userA), {
      email: 'dup@example.com',
      tokenHash: 'hash-dup-expired',
      expiresAt: Date.now() - 1_000,
    });
    expect(
      await getPendingInvitationByInviterAndEmail(env, actor(userA), 'dup@example.com'),
    ).toBeUndefined();

    const fresh = await createInvitation(env, actor(userA), {
      email: 'dup@example.com',
      tokenHash: 'hash-dup-fresh',
      expiresAt: Date.now() + 1_000,
    });
    const found = await getPendingInvitationByInviterAndEmail(env, actor(userA), 'dup@example.com');
    expect(found?.id).toBe(fresh!.id);
  });

  it('delete only removes the inviter\'s own row', async () => {
    const invitation = await createInvitation(env, actor(userA), {
      email: 'gone@example.com',
      tokenHash: 'hash-delete',
      expiresAt: Date.now() + 1_000,
    });
    const deniedAttempt = await deleteInvitation(env, actor(userB), invitation!.id);
    expect(deniedAttempt).toBeUndefined();

    const deleted = await deleteInvitation(env, actor(userA), invitation!.id);
    expect(deleted?.id).toBe(invitation!.id);
  });
});
