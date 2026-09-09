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

async function makeConversationWithMessage(prefix: string) {
  const a = await signUpAndVerify(`${prefix}-a@example.com`, 'A');
  const b = await signUpAndVerify(`${prefix}-b@example.com`, 'B');
  await post('/api/friends/invite', a, { email: `${prefix}-b@example.com` });
  const aFriends = await SELF.fetch(`${BASE}/api/friends`, { headers: { Cookie: a } });
  const { outgoing } = await aFriends.json<{ outgoing: { friendshipId: string }[] }>();
  const friendshipId = outgoing[0]!.friendshipId;
  const acceptRes = await post(`/api/friends/${friendshipId}/accept`, b);
  const { conversationId } = await acceptRes.json<{ conversationId: string }>();

  const sendRes = await post(`/api/conversations/${conversationId}/messages`, a, {
    clientId: 'del-target',
    kind: 'text',
    body: 'delete this',
  });
  const { message } = await sendRes.json<{ message: { seq: number } }>();
  return { conversationId, seq: message.seq, a, b };
}

describe('messages routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('DELETE /:conversationId/:seq: sender can delete, tombstones the body', async () => {
    const { conversationId, seq, a } = await makeConversationWithMessage('msg-delete');

    const res = await SELF.fetch(`${BASE}/api/messages/${conversationId}/${seq}`, {
      method: 'DELETE',
      headers: { Cookie: a, Origin: ORIGIN },
    });
    expect(res.status).toBe(204);

    const listRes = await SELF.fetch(`${BASE}/api/conversations/${conversationId}/messages`, {
      headers: { Cookie: a },
    });
    const { messages } = await listRes.json<{ messages: { seq: number; body: string | null; deletedAt: number | null }[] }>();
    const deleted = messages.find((m) => m.seq === seq);
    expect(deleted?.body).toBeNull();
    expect(deleted?.deletedAt).not.toBeNull();
  });

  it('DELETE /:conversationId/:seq: a non-sender member is forbidden', async () => {
    const { conversationId, seq, b } = await makeConversationWithMessage('msg-forbid');

    const res = await SELF.fetch(`${BASE}/api/messages/${conversationId}/${seq}`, {
      method: 'DELETE',
      headers: { Cookie: b, Origin: ORIGIN },
    });
    expect(res.status).toBe(403);
  });

  it('DELETE /:conversationId/:seq: a stranger gets not-found', async () => {
    const { conversationId, seq } = await makeConversationWithMessage('msg-stranger');
    const stranger = await signUpAndVerify('msg-stranger-x@example.com', 'Stranger');

    const res = await SELF.fetch(`${BASE}/api/messages/${conversationId}/${seq}`, {
      method: 'DELETE',
      headers: { Cookie: stranger, Origin: ORIGIN },
    });
    expect(res.status).toBe(404);
  });

  it('DELETE /:conversationId/:seq: a missing seq is 404', async () => {
    const { conversationId, a } = await makeConversationWithMessage('msg-missing');

    const res = await SELF.fetch(`${BASE}/api/messages/${conversationId}/999999`, {
      method: 'DELETE',
      headers: { Cookie: a, Origin: ORIGIN },
    });
    expect(res.status).toBe(404);
  });

  it('requires auth', async () => {
    const res = await SELF.fetch(`${BASE}/api/messages/whatever/1`, {
      method: 'DELETE',
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(401);
  });
});
