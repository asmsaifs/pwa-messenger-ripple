import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

const BASE = 'https://example.com';
const ORIGIN = 'http://localhost:8787';

function extractLoggedUrl(spy: ReturnType<typeof vi.spyOn>, marker: string): string {
  const call = spy.mock.calls.find(([line]) => String(line).includes(marker));
  if (!call) throw new Error(`no logged email matched "${marker}"`);
  const match = String(call[0]).match(/(https?:\/\/\S+)/);
  if (!match) throw new Error('no URL found in logged email');
  return match[1]!;
}

async function signUpAndVerify(email: string, name: string): Promise<string> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  await SELF.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name }),
  });
  const verifyUrl = extractLoggedUrl(logSpy, 'verify-email');
  const verifyRes = await SELF.fetch(verifyUrl, { redirect: 'manual' });
  const setCookie = verifyRes.headers.get('set-cookie');
  if (!setCookie) throw new Error('verify-email set no cookie');
  return setCookie.split(';')[0]!;
}

function post(path: string, cookie: string, body?: unknown) {
  return SELF.fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: ORIGIN },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function makeConversation(prefix: string) {
  const a = await signUpAndVerify(`${prefix}-a@example.com`, 'A');
  const b = await signUpAndVerify(`${prefix}-b@example.com`, 'B');
  await post('/api/friends/invite', a, { email: `${prefix}-b@example.com` });
  const aFriends = await SELF.fetch(`${BASE}/api/friends`, { headers: { Cookie: a } });
  const { outgoing } = await aFriends.json<{ outgoing: { friendshipId: string }[] }>();
  const friendshipId = outgoing[0]!.friendshipId;
  const acceptRes = await post(`/api/friends/${friendshipId}/accept`, b);
  const { conversationId } = await acceptRes.json<{ conversationId: string }>();
  return { conversationId, a, b };
}

async function connect(conversationId: string, cookie: string): Promise<WebSocket> {
  const res = await SELF.fetch(`${BASE}/api/ws/conversation/${conversationId}`, {
    headers: { Cookie: cookie, Upgrade: 'websocket', Origin: ORIGIN },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error(`expected a WebSocket upgrade, got status ${res.status}`);
  ws.accept();
  return ws;
}

function nextFrame(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for a frame')), 2000);
    ws.addEventListener(
      'message',
      (event: MessageEvent) => {
        clearTimeout(timeout);
        resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
      },
      { once: true },
    );
  });
}

describe('ws routes (ConversationDO WS protocol)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a ready frame with lastSeq on connect', async () => {
    const { conversationId, a } = await makeConversation('ws-ready');
    const ws = await connect(conversationId, a);
    const ready = await nextFrame(ws);
    expect(ready).toMatchObject({ t: 'ready', lastSeq: 0 });
    ws.close();
  });

  it('send/echo: a message sent over the socket is broadcast back, including to the sender', async () => {
    const { conversationId, a } = await makeConversation('ws-send');
    const ws = await connect(conversationId, a);
    await nextFrame(ws); // ready

    ws.send(JSON.stringify({ t: 'send', clientId: 'ws-1', kind: 'text', body: 'hi over ws' }));
    const frame = await nextFrame(ws);
    expect(frame).toMatchObject({ t: 'message', message: { body: 'hi over ws', clientId: 'ws-1' } });
    ws.close();
  });

  // A second concurrent socket to the same conversation (needed to observe a
  // *cross*-socket broadcast, e.g. typing to a peer) reliably hangs the pinned
  // Miniflare version this repo runs on (3.20250204.1) — verified in
  // isolation, not specific to this frame type. The single-socket tests above
  // and below already exercise `broadcast()`'s delivery path (self-echo on
  // `send`, and every server→client frame the protocol defines); cross-socket
  // fan-out for typing/read/presence needs a `wrangler dev` manual check
  // (docs/09 M6 exit criteria) or a Miniflare upgrade, not a unit test here.
  it('typing: accepted and does not error the connection (self is not echoed)', async () => {
    const { conversationId, a } = await makeConversation('ws-typing');
    const ws = await connect(conversationId, a);
    await nextFrame(ws); // ready

    ws.send(JSON.stringify({ t: 'typing', on: true }));
    // No broadcast to self — confirm the socket is still alive and processing
    // frames by round-tripping a ping right after.
    ws.send(JSON.stringify({ t: 'ping' }));
    const pong = await nextFrame(ws);
    expect(pong).toEqual({ t: 'pong' });
    ws.close();
  });

  it('gap-fill (E2E #13): messages sent over HTTP while disconnected backfill exactly via hello, no dupes/holes', async () => {
    const { conversationId, a, b } = await makeConversation('ws-gapfill');

    const ws1 = await connect(conversationId, a);
    await nextFrame(ws1); // ready at lastSeq 0
    ws1.close();

    // Peer sends 3 messages over the HTTP fallback path while A's socket is down.
    for (let i = 0; i < 3; i++) {
      const res = await post(`/api/conversations/${conversationId}/messages`, b, {
        clientId: `gap-${i}`,
        kind: 'text',
        body: `m${i}`,
      });
      expect(res.status).toBe(200);
    }

    // A reconnects and asks for everything since seq 0.
    const ws2 = await connect(conversationId, a);
    await nextFrame(ws2); // ready
    ws2.send(JSON.stringify({ t: 'hello', lastSeq: 0 }));
    const backfill = await nextFrame(ws2);
    expect(backfill['t']).toBe('backfill');
    const messages = backfill['messages'] as { seq: number; body: string }[];
    expect(messages.map((m) => m.body)).toEqual(['m0', 'm1', 'm2']);
    expect(backfill['hasMore']).toBe(false);
    // No dupes/holes: seq is exactly 1,2,3.
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3]);

    ws2.close();
  });

  it('a stranger cannot open the socket', async () => {
    const { conversationId } = await makeConversation('ws-stranger');
    const stranger = await signUpAndVerify('ws-stranger-x@example.com', 'Stranger');

    const res = await SELF.fetch(`${BASE}/api/ws/conversation/${conversationId}`, {
      headers: { Cookie: stranger, Upgrade: 'websocket', Origin: ORIGIN },
    });
    expect(res.status).toBe(404);
  });

  it('requires auth', async () => {
    const res = await SELF.fetch(`${BASE}/api/ws/conversation/whatever`, {
      headers: { Upgrade: 'websocket', Origin: ORIGIN },
    });
    expect(res.status).toBe(401);
  });
});

describe('ws routes (UserDO personal socket, docs/09 M7)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function connectUser(cookie: string): Promise<WebSocket> {
    const res = await SELF.fetch(`${BASE}/api/ws/user`, {
      headers: { Cookie: cookie, Upgrade: 'websocket', Origin: ORIGIN },
    });
    const ws = res.webSocket;
    if (!ws) throw new Error(`expected a WebSocket upgrade, got status ${res.status}`);
    ws.accept();
    return ws;
  }

  it('requires auth', async () => {
    const res = await SELF.fetch(`${BASE}/api/ws/user`, {
      headers: { Upgrade: 'websocket', Origin: ORIGIN },
    });
    expect(res.status).toBe(401);
  });

  it('ping/pong round-trips', async () => {
    const a = await signUpAndVerify('userdo-ping@example.com', 'A');
    const ws = await connectUser(a);
    ws.send(JSON.stringify({ t: 'ping' }));
    const pong = await nextFrame(ws);
    expect(pong).toEqual({ t: 'pong' });
    ws.close();
  });

  it('a new message bumps the recipient\'s unread badge across two open sockets (multi-tab)', async () => {
    const { conversationId, a, b } = await makeConversation('userdo-unread');
    const bTab1 = await connectUser(b);
    const bTab2 = await connectUser(b);

    const meBeforeRes = await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: b } });
    const meBefore = await meBeforeRes.json<{ unreadTotal: number }>();
    expect(meBefore.unreadTotal).toBe(0);

    const sendRes = await post(`/api/conversations/${conversationId}/messages`, a, {
      clientId: 'userdo-1',
      kind: 'text',
      body: 'hi',
    });
    expect(sendRes.status).toBe(200);

    const frame1 = await nextFrame(bTab1);
    const frame2 = await nextFrame(bTab2);
    expect(frame1).toMatchObject({ t: 'unread', conversationId, count: 1, total: 1 });
    expect(frame2).toMatchObject({ t: 'unread', conversationId, count: 1, total: 1 });

    // Marking read from one tab clears it for both.
    await post(`/api/conversations/${conversationId}/read`, b, { seq: 1 });
    const cleared1 = await nextFrame(bTab1);
    const cleared2 = await nextFrame(bTab2);
    expect(cleared1).toEqual({ t: 'unread', conversationId, count: 0, total: 0 });
    expect(cleared2).toEqual({ t: 'unread', conversationId, count: 0, total: 0 });

    const meAfterRes = await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: b } });
    const meAfter = await meAfterRes.json<{ unreadTotal: number }>();
    expect(meAfter.unreadTotal).toBe(0);

    bTab1.close();
    bTab2.close();
  });

  it('accepting a friend request notifies the requester\'s personal socket', async () => {
    const a = await signUpAndVerify('userdo-fr-a@example.com', 'A');
    const b = await signUpAndVerify('userdo-fr-b@example.com', 'B');
    const aSocket = await connectUser(a);

    await post('/api/friends/invite', a, { email: 'userdo-fr-b@example.com' });
    const aFriends = await SELF.fetch(`${BASE}/api/friends`, { headers: { Cookie: a } });
    const { outgoing } = await aFriends.json<{ outgoing: { friendshipId: string }[] }>();
    const friendshipId = outgoing[0]!.friendshipId;

    const acceptRes = await post(`/api/friends/${friendshipId}/accept`, b);
    const { conversationId } = await acceptRes.json<{ conversationId: string }>();

    const frame = await nextFrame(aSocket);
    expect(frame).toMatchObject({ t: 'friend_accepted', conversationId });
    aSocket.close();
  });
});

// docs/03 §2.1/§4, docs/09 M12: "enqueues push-queue for members with no
// live socket". Spies directly on the `PUSH_QUEUE` binding rather than
// draining the queue end-to-end — the consumer side (src/server/push/
// consumer.ts) already has its own coverage in
// src/server/push/consumer.test.ts, so this only needs to prove the
// producer's "is this member actually offline" branch is correct.
describe('push-queue fan-out (docs/09 M12)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function connectUser(cookie: string): Promise<WebSocket> {
    const res = await SELF.fetch(`${BASE}/api/ws/user`, {
      headers: { Cookie: cookie, Upgrade: 'websocket', Origin: ORIGIN },
    });
    const ws = res.webSocket;
    if (!ws) throw new Error(`expected a WebSocket upgrade, got status ${res.status}`);
    ws.accept();
    return ws;
  }

  it('a message to an offline recipient enqueues a push job', async () => {
    const { conversationId, a, b } = await makeConversation('push-msg-offline');
    const bMeRes = await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: b } });
    const bMe = await bMeRes.json<{ user: { id: string } }>();
    const sendSpy = vi.spyOn(env.PUSH_QUEUE, 'send');

    const res = await post(`/api/conversations/${conversationId}/messages`, a, {
      clientId: 'push-msg-1',
      kind: 'text',
      body: 'are you there?',
    });
    expect(res.status).toBe(200);

    expect(sendSpy).toHaveBeenCalledOnce();
    const job = sendSpy.mock.calls[0]![0] as {
      userId: string;
      payload: { type: string; tag: string; data: { url: string } };
    };
    expect(job.userId).toBe(bMe.user.id);
    expect(job.payload.type).toBe('message');
    expect(job.payload.tag).toBe(`msg-${conversationId}`);
    expect(job.payload.data.url).toBe(`/c/${conversationId}`);
  });

  it('a message to a recipient with a live UserDO socket does not enqueue a push job', async () => {
    const { conversationId, a, b } = await makeConversation('push-msg-online');
    const bSocket = await connectUser(b);
    const sendSpy = vi.spyOn(env.PUSH_QUEUE, 'send');

    const res = await post(`/api/conversations/${conversationId}/messages`, a, {
      clientId: 'push-msg-online-1',
      kind: 'text',
      body: 'hi',
    });
    expect(res.status).toBe(200);
    await nextFrame(bSocket); // the unread bump — proves the fan-out ran before asserting push didn't

    expect(sendSpy).not.toHaveBeenCalled();
    bSocket.close();
  });

  it('a friend request to an offline recipient enqueues a push job', async () => {
    const a = await signUpAndVerify('push-fr-a@example.com', 'A');
    await signUpAndVerify('push-fr-b@example.com', 'B');
    const sendSpy = vi.spyOn(env.PUSH_QUEUE, 'send');

    const res = await post('/api/friends/invite', a, { email: 'push-fr-b@example.com' });
    expect(res.status).toBe(200);

    expect(sendSpy).toHaveBeenCalledOnce();
    const job = sendSpy.mock.calls[0]![0] as { payload: { type: string; tag: string } };
    expect(job.payload.type).toBe('friend_request');
  });

  it('a friend request to a recipient with a live socket does not enqueue a push job', async () => {
    const a = await signUpAndVerify('push-fr-online-a@example.com', 'A');
    const b = await signUpAndVerify('push-fr-online-b@example.com', 'B');
    const bSocket = await connectUser(b);
    const sendSpy = vi.spyOn(env.PUSH_QUEUE, 'send');

    const res = await post('/api/friends/invite', a, { email: 'push-fr-online-b@example.com' });
    expect(res.status).toBe(200);
    await nextFrame(bSocket); // the friend_request frame

    expect(sendSpy).not.toHaveBeenCalled();
    bSocket.close();
  });
});
