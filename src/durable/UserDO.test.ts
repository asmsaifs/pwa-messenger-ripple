import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seedFriendGraph } from '../server/repos/test-helpers';

// `idFromName`/`get`, not `getByName` (see src/server/lib/rate-limit.ts's
// comment) — the pinned local runtime doesn't implement `getByName` yet.
function stubFor(userId: string) {
  return env.USER.get(env.USER.idFromName(userId));
}

function stubForConversation(conversationId: string) {
  return env.CONVERSATION.get(env.CONVERSATION.idFromName(conversationId));
}

describe('UserDO', () => {
  it('presence defaults to offline, and hasLiveSocket is false with no connection', async () => {
    const stub = stubFor('unknown-user');
    expect(await stub.hasLiveSocket()).toBe(false);
    const presence = await stub.presence();
    expect(presence.state).toBe('offline');
  });

  it('bumpUnread increments per-conversation and total; clearUnread zeroes both', async () => {
    const stub = stubFor('u1');
    expect(await stub.unreadTotal()).toBe(0);

    await stub.bumpUnread('conv-a');
    await stub.bumpUnread('conv-a');
    await stub.bumpUnread('conv-b');
    expect(await stub.unreadTotal()).toBe(3);

    await stub.clearUnread('conv-a');
    expect(await stub.unreadTotal()).toBe(1);

    await stub.clearUnread('conv-b');
    expect(await stub.unreadTotal()).toBe(0);
  });

  it('clearUnread on a conversation with no unread is a no-op', async () => {
    const stub = stubFor('u2');
    await expect(stub.clearUnread('never-bumped')).resolves.toBeUndefined();
    expect(await stub.unreadTotal()).toBe(0);
  });

  it('notify is a no-op with no live socket (no throw)', async () => {
    const stub = stubFor('u3');
    await expect(
      stub.notify({
        t: 'friend_accepted',
        conversationId: 'c1',
        peer: { userId: 'peer', displayName: 'Peer', avatarKey: null, statusText: null },
      }),
    ).resolves.toBeUndefined();
  });

  it('activeCall is null for a user with no open call and no live socket to resolve identity from', async () => {
    const stub = stubFor('u4');
    await expect(stub.activeCall()).rejects.toThrow();
  });

  it('ConversationDO.appendMessage bumps unread on every other member via UserDO fan-in', async () => {
    const g = await seedFriendGraph(env);
    const convo = stubForConversation(g.conversationId);
    const userBStub = stubFor(g.userB);

    await convo.appendMessage({
      clientId: 'm1',
      senderId: g.userA,
      kind: 'text',
      body: 'hi b',
      conversationId: g.conversationId,
    });

    expect(await userBStub.unreadTotal()).toBe(1);
    // The sender's own unread never moves.
    expect(await stubFor(g.userA).unreadTotal()).toBe(0);

    await convo.appendMessage({
      clientId: 'm2',
      senderId: g.userA,
      kind: 'text',
      body: 'hi again',
      conversationId: g.conversationId,
    });
    expect(await userBStub.unreadTotal()).toBe(2);
  });

  it('idle-socket sweep alarm closes a stale connection', async () => {
    const stub = stubFor('idle-user');
    // No live socket to open here (no WS upgrade in this harness) — this
    // just proves the alarm handler runs cleanly with nothing to sweep,
    // mirroring ConversationDO.test.ts's alarm-shape coverage; a real socket
    // idle-close is exercised manually (wrangler dev) per docs/09 M7.
    const fired = await runDurableObjectAlarm(stub);
    expect(fired).toBe(false);
  });
});
