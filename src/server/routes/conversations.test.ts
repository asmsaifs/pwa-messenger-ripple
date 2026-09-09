import { env, runDurableObjectAlarm, SELF } from 'cloudflare:test';
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

describe('conversations routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /api/conversations starts empty, then lists after a friendship is accepted', async () => {
    const a = await signUpAndVerify('conv-empty@example.com', 'Empty');
    const empty = await SELF.fetch(`${BASE}/api/conversations`, { headers: { Cookie: a } });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ conversations: [] });

    const { conversationId, a: a2 } = await makeConversation('conv-list');
    const list = await SELF.fetch(`${BASE}/api/conversations`, { headers: { Cookie: a2 } });
    const body = await list.json<{ conversations: { id: string; unreadCount: number }[] }>();
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]!.id).toBe(conversationId);
    expect(body.conversations[0]!.unreadCount).toBe(0);
  });

  it('GET /api/conversations/:id returns peer info; a stranger gets not-found', async () => {
    const { conversationId, a, b } = await makeConversation('conv-detail');
    const stranger = await signUpAndVerify('conv-detail-stranger@example.com', 'Stranger');

    const detail = await SELF.fetch(`${BASE}/api/conversations/${conversationId}`, {
      headers: { Cookie: a },
    });
    expect(detail.status).toBe(200);
    const body = await detail.json<{ peer: { displayName: string } }>();
    expect(body.peer.displayName).toBe('B');
    void b;

    const denied = await SELF.fetch(`${BASE}/api/conversations/${conversationId}`, {
      headers: { Cookie: stranger },
    });
    expect(denied.status).toBe(404);
  });

  it('POST /:id/messages (HTTP fallback) sends, and is idempotent on clientId', async () => {
    const { conversationId, a, b } = await makeConversation('conv-send');

    const res = await post(`/api/conversations/${conversationId}/messages`, a, {
      clientId: 'http-1',
      kind: 'text',
      body: 'hello via http',
    });
    expect(res.status).toBe(200);
    const { message } = await res.json<{ message: { seq: number; body: string } }>();
    expect(message.body).toBe('hello via http');

    const dup = await post(`/api/conversations/${conversationId}/messages`, a, {
      clientId: 'http-1',
      kind: 'text',
      body: 'hello via http',
    });
    const dupBody = await dup.json<{ message: { seq: number } }>();
    expect(dupBody.message.seq).toBe(message.seq);

    const messagesRes = await SELF.fetch(
      `${BASE}/api/conversations/${conversationId}/messages`,
      { headers: { Cookie: b } },
    );
    const { messages } = await messagesRes.json<{ messages: { body: string }[] }>();
    expect(messages).toHaveLength(1);
  });

  it('POST /:id/messages is denied for a stranger (not-found, no existence leak)', async () => {
    const { conversationId } = await makeConversation('conv-deny');
    const stranger = await signUpAndVerify('conv-deny-stranger@example.com', 'Stranger');

    const res = await post(`/api/conversations/${conversationId}/messages`, stranger, {
      clientId: 'x',
      kind: 'text',
      body: 'nope',
    });
    expect(res.status).toBe(404);
  });

  it('POST /:id/read only moves lastReadSeq forward, reflected in unreadCount', async () => {
    const { conversationId, a, b } = await makeConversation('conv-read');
    await post(`/api/conversations/${conversationId}/messages`, a, {
      clientId: 'r1',
      kind: 'text',
      body: 'one',
    });
    await post(`/api/conversations/${conversationId}/messages`, a, {
      clientId: 'r2',
      kind: 'text',
      body: 'two',
    });
    // `conversations.lastSeq` (the D1 side `unreadCount` reads) only updates
    // once the DO's debounced preview alarm fires (docs/01 §3) — force it
    // here rather than asserting against a stale pre-flush value.
    const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(conversationId));
    await runDurableObjectAlarm(stub);

    const beforeRead = await SELF.fetch(`${BASE}/api/conversations`, { headers: { Cookie: b } });
    const beforeBody = await beforeRead.json<{ conversations: { unreadCount: number }[] }>();
    expect(beforeBody.conversations[0]!.unreadCount).toBe(2);

    const readRes = await post(`/api/conversations/${conversationId}/read`, b, { seq: 2 });
    expect(readRes.status).toBe(204);

    const afterRead = await SELF.fetch(`${BASE}/api/conversations`, { headers: { Cookie: b } });
    const afterBody = await afterRead.json<{ conversations: { unreadCount: number }[] }>();
    expect(afterBody.conversations[0]!.unreadCount).toBe(0);
  });

  it('POST /:id/mute sets mutedUntil for the actor only', async () => {
    const { conversationId, a } = await makeConversation('conv-mute');
    const muteRes = await post(`/api/conversations/${conversationId}/mute`, a, { until: 123456 });
    expect(muteRes.status).toBe(204);

    const list = await SELF.fetch(`${BASE}/api/conversations`, { headers: { Cookie: a } });
    const body = await list.json<{ conversations: { mutedUntil: number | null }[] }>();
    expect(body.conversations[0]!.mutedUntil).toBe(123456);
  });

  it('requires auth', async () => {
    const res = await SELF.fetch(`${BASE}/api/conversations`);
    expect(res.status).toBe(401);
  });
});
