import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seedFriendGraph } from '../server/repos/test-helpers';
import type { Message } from '../shared/messages';

// `idFromName`/`get`, not `getByName` (see src/server/lib/rate-limit.ts's
// comment) — the pinned local runtime doesn't implement `getByName` yet.
function stubFor(conversationId: string) {
  return env.CONVERSATION.get(env.CONVERSATION.idFromName(conversationId));
}

// Raw D1 read (no drizzle import here — only src/server/repos/** may import
// it) to assert what the DO's debounced alarm actually wrote.
async function readConversationRow(conversationId: string) {
  return env.DB.prepare(
    `SELECT last_message_preview, last_message_sender, last_seq FROM conversations WHERE id = ?`,
  )
    .bind(conversationId)
    .first<{ last_message_preview: string | null; last_message_sender: string | null; last_seq: number }>();
}

describe('ConversationDO', () => {
  it('dedupes on clientId, including a same-tick race', async () => {
    const g = await seedFriendGraph(env);
    const stub = stubFor(g.conversationId);

    const [x, y] = await Promise.all([
      stub.appendMessage({ clientId: 'k1', senderId: g.userA, kind: 'text', body: 'hi', conversationId: g.conversationId }),
      stub.appendMessage({ clientId: 'k1', senderId: g.userA, kind: 'text', body: 'hi', conversationId: g.conversationId }),
    ]);
    expect(x.seq).toBe(y.seq);
    expect(x.id).toBe(y.id);

    const again = await stub.appendMessage({
      clientId: 'k1',
      senderId: g.userA,
      kind: 'text',
      body: 'hi',
      conversationId: g.conversationId,
    });
    expect(again.seq).toBe(x.seq);

    const stats = await stub.stats();
    expect(stats.count).toBe(1);
  });

  it('assigns gapless, monotonic seq under concurrent appends', async () => {
    const g = await seedFriendGraph(env);
    const stub = stubFor(g.conversationId);

    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        stub.appendMessage({
          clientId: `c-${i}`,
          senderId: g.userA,
          kind: 'text',
          body: `m${i}`,
          conversationId: g.conversationId,
        }),
      ),
    );
    const seqs = results.map((m: Message) => m.seq).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));

    const stats = await stub.stats();
    expect(stats.count).toBe(N);
    expect(stats.lastSeq).toBe(N);
  });

  it('debounces the D1 preview write: N sends before the alarm fires produce exactly one write, reflecting the last message', async () => {
    const g = await seedFriendGraph(env);
    const stub = stubFor(g.conversationId);

    await stub.appendMessage({ clientId: 'p1', senderId: g.userA, kind: 'text', body: 'first', conversationId: g.conversationId });
    await stub.appendMessage({ clientId: 'p2', senderId: g.userA, kind: 'text', body: 'second', conversationId: g.conversationId });
    await stub.appendMessage({ clientId: 'p3', senderId: g.userA, kind: 'text', body: 'third', conversationId: g.conversationId });

    const before = await readConversationRow(g.conversationId);
    expect(before?.last_message_preview).toBeNull(); // not flushed yet — proves the write is debounced, not per-send

    // Each `appendMessage` call pushed the pending alarm forward (debounce)
    // rather than each firing its own — a single run should be pending.
    const fired = await runDurableObjectAlarm(stub);
    expect(fired).toBe(true);

    const after = await readConversationRow(g.conversationId);
    expect(after?.last_message_preview).toBe('third');
    expect(after?.last_message_sender).toBe(g.userA);
    expect(after?.last_seq).toBe(3);

    // Nothing pending after the flush — a second run is a no-op fire, not a
    // second (and possibly stale) D1 write.
    const secondFire = await runDurableObjectAlarm(stub);
    expect(secondFire).toBe(false);
  });

  it('listMessages (backward pagination, also used to cap backfill) never exceeds cap + 1', async () => {
    const g = await seedFriendGraph(env);
    const stub = stubFor(g.conversationId);

    for (let i = 0; i < 5; i++) {
      await stub.appendMessage({
        clientId: `bf-${i}`,
        senderId: g.userA,
        kind: 'text',
        body: `m${i}`,
        conversationId: g.conversationId,
      });
    }

    const page = await stub.listMessages(null, 10_000);
    expect(page.length).toBeLessThanOrEqual(501); // 500 cap + 1 hasMore sentinel
    expect(page.length).toBe(5); // under cap — no sentinel row
  });

  it('membershipChanged updates the cache without throwing', async () => {
    const g = await seedFriendGraph(env);
    const stub = stubFor(g.conversationId);

    await expect(
      stub.membershipChanged([{ userId: g.userA, status: 'removed' }]),
    ).resolves.toBeUndefined();
    await expect(
      stub.membershipChanged([{ userId: g.userA, status: 'member' }]),
    ).resolves.toBeUndefined();
  });

  it('getMessageBySeq / deleteMessage round-trip a tombstone', async () => {
    const g = await seedFriendGraph(env);
    const stub = stubFor(g.conversationId);

    const sent = await stub.appendMessage({
      clientId: 'del1',
      senderId: g.userA,
      kind: 'text',
      body: 'delete me',
      conversationId: g.conversationId,
    });
    const found = await stub.getMessageBySeq(sent.seq);
    expect(found?.body).toBe('delete me');

    const deleted = await stub.deleteMessage(sent.seq);
    expect(deleted?.body).toBeNull();
    expect(deleted?.deletedAt).not.toBeNull();

    const missing = await stub.getMessageBySeq(999_999);
    expect(missing).toBeUndefined();
  });

  it('keeps message rows isolated per conversation (separate DO instances)', async () => {
    const g = await seedFriendGraph(env);
    const stub1 = stubFor(g.conversationId);
    const stub2 = stubFor(g.blockedConversationId);

    await stub1.appendMessage({
      clientId: 'iso1',
      senderId: g.userA,
      kind: 'text',
      body: 'in conv 1',
      conversationId: g.conversationId,
    });
    const stats1 = await stub1.stats();
    const stats2 = await stub2.stats();
    expect(stats1.count).toBe(1);
    expect(stats2.count).toBe(0);
  });
});
