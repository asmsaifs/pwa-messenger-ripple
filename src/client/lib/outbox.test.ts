import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './db';
import {
  enqueueOutboxMessage,
  flushOutbox,
  flushOutboxEntry,
  listOutbox,
  retryOutboxEntry,
} from './outbox';

// docs/09 M8 exit criterion: "3 concurrent flushes produce exactly one
// message." The DO's `UNIQUE(client_id)` (docs/02 §2) is the cross-tab half
// of that guarantee; this suite covers the client half — the in-process
// mutex in outbox.ts that stops a single tab from firing the request 3 times
// in the first place.
describe('outbox', () => {
  beforeEach(async () => {
    await db.outbox.clear();
    await db.messages.clear();
    await db.meta.clear();
    vi.restoreAllMocks();
  });

  it('dedupes concurrent flushes of the same clientId into a single request', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        calls += 1;
        return new Response(
          JSON.stringify({
            message: {
              seq: 1,
              id: 'm1',
              clientId: 'c1',
              senderId: 'u1',
              kind: 'text',
              body: 'hi',
              attachmentId: null,
              callId: null,
              replyToSeq: null,
              deletedAt: null,
              createdAt: Date.now(),
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    await enqueueOutboxMessage({
      clientId: 'c1',
      conversationId: 'conv1',
      kind: 'text',
      body: 'hi',
    });

    await Promise.all([
      flushOutboxEntry('c1'),
      flushOutboxEntry('c1'),
      flushOutboxEntry('c1'),
    ]);

    expect(calls).toBe(1);
    const rows = await listOutbox('conv1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('sent');

    vi.unstubAllGlobals();
  });

  it('flushes queued messages in send order', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          clientId: string;
        };
        seen.push(body.clientId);
        return new Response(
          JSON.stringify({
            message: {
              seq: seen.length,
              id: `m${seen.length}`,
              clientId: body.clientId,
              senderId: 'u1',
              kind: 'text',
              body: 'x',
              attachmentId: null,
              callId: null,
              replyToSeq: null,
              deletedAt: null,
              createdAt: Date.now(),
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    await enqueueOutboxMessage({
      clientId: 'a',
      conversationId: 'conv1',
      kind: 'text',
      body: '1',
    });
    await enqueueOutboxMessage({
      clientId: 'b',
      conversationId: 'conv1',
      kind: 'text',
      body: '2',
    });
    await enqueueOutboxMessage({
      clientId: 'c',
      conversationId: 'conv1',
      kind: 'text',
      body: '3',
    });

    await flushOutbox();

    expect(seen).toEqual(['a', 'b', 'c']);
    vi.unstubAllGlobals();
  });

  it('keeps a failed entry pending (not error) when the network is offline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await enqueueOutboxMessage({
      clientId: 'c2',
      conversationId: 'conv1',
      kind: 'text',
      body: 'hi',
    });
    await flushOutboxEntry('c2');

    const rows = await listOutbox('conv1');
    expect(rows[0]?.status).toBe('pending');
    vi.unstubAllGlobals();
  });

  it('marks a real server error as failed and lets retry re-attempt it', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        calls += 1;
        if (calls === 1) {
          return new Response(
            JSON.stringify({ error: { code: 'policy/blocked', message: 'blocked' } }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            message: {
              seq: 1,
              id: 'm1',
              clientId: 'c3',
              senderId: 'u1',
              kind: 'text',
              body: 'hi',
              attachmentId: null,
              callId: null,
              replyToSeq: null,
              deletedAt: null,
              createdAt: Date.now(),
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    await enqueueOutboxMessage({
      clientId: 'c3',
      conversationId: 'conv1',
      kind: 'text',
      body: 'hi',
    });
    await flushOutboxEntry('c3');

    let rows = await listOutbox('conv1');
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.lastErrorCode).toBe('policy/blocked');

    await retryOutboxEntry('c3');
    rows = await listOutbox('conv1');
    expect(rows[0]?.status).toBe('sent');
    expect(calls).toBe(2);
    vi.unstubAllGlobals();
  });
});
