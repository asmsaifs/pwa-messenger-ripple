import { SELF } from 'cloudflare:test';
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
