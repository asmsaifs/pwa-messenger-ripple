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

describe('friends routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /api/friends starts empty', async () => {
    const cookie = await signUpAndVerify('friends-empty@example.com', 'Empty');
    const res = await SELF.fetch(`${BASE}/api/friends`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = await res.json<{ friends: unknown[]; incoming: unknown[]; outgoing: unknown[] }>();
    expect(body).toMatchObject({ friends: [], incoming: [], outgoing: [] });
  });

  it('inviting a registered user creates a request; the other side accepts into a conversation', async () => {
    const a = await signUpAndVerify('invite-a@example.com', 'Alice');
    const bCookie = await signUpAndVerify('invite-b@example.com', 'Bob');

    const inviteRes = await post('/api/friends/invite', a, { email: 'invite-b@example.com' });
    expect(inviteRes.status).toBe(200);
    expect(await inviteRes.json()).toEqual({ kind: 'request_sent' });

    const aFriends = await SELF.fetch(`${BASE}/api/friends`, { headers: { Cookie: a } });
    const aBody = await aFriends.json<{ outgoing: { friendshipId: string }[] }>();
    expect(aBody.outgoing).toHaveLength(1);
    const friendshipId = aBody.outgoing[0]!.friendshipId;

    const acceptRes = await post(`/api/friends/${friendshipId}/accept`, bCookie);
    expect(acceptRes.status).toBe(200);
    const acceptBody = await acceptRes.json<{ conversationId: string }>();
    expect(acceptBody.conversationId).toBeTruthy();

    const aFriendsAfter = await SELF.fetch(`${BASE}/api/friends`, { headers: { Cookie: a } });
    const aAfterBody = await aFriendsAfter.json<{ friends: { userId: string }[] }>();
    expect(aAfterBody.friends).toHaveLength(1);
  });

  it('inviting an unregistered email sends an invite and lists it under "invitations"', async () => {
    const inviter = await signUpAndVerify('inviter-email@example.com', 'Inviter');
    const res = await post('/api/friends/invite', inviter, { email: 'unregistered@example.com' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'email_sent' });

    const list = await SELF.fetch(`${BASE}/api/friends`, { headers: { Cookie: inviter } });
    const body = await list.json<{ invitations: { email: string }[] }>();
    expect(body.invitations.map((i) => i.email)).toContain('unregistered@example.com');
  });

  it('blocking then unblocking round-trips; only the blocker may unblock', async () => {
    const a = await signUpAndVerify('block-a@example.com', 'A');
    const bCookie = await signUpAndVerify('block-b@example.com', 'B');
    await post('/api/friends/invite', a, { email: 'block-b@example.com' });

    const aList = await SELF.fetch(`${BASE}/api/friends`, { headers: { Cookie: a } });
    const { outgoing } = await aList.json<{ outgoing: { friendshipId: string }[] }>();
    const friendshipId = outgoing[0]!.friendshipId;
    await post(`/api/friends/${friendshipId}/accept`, bCookie);

    const blockRes = await post(`/api/friends/${friendshipId}/block`, a);
    expect(blockRes.status).toBe(204);

    const deniedUnblock = await post(`/api/friends/${friendshipId}/unblock`, bCookie);
    expect(deniedUnblock.status).toBe(403);

    const allowedUnblock = await post(`/api/friends/${friendshipId}/unblock`, a);
    expect(allowedUnblock.status).toBe(204);
  });

  it('a blocked friendship shows in the blocker\'s "blocked" list, not the blocked party\'s any list', async () => {
    const a = await signUpAndVerify('block-list-a@example.com', 'A');
    const bCookie = await signUpAndVerify('block-list-b@example.com', 'B');
    await post('/api/friends/invite', a, { email: 'block-list-b@example.com' });

    const aList = await SELF.fetch(`${BASE}/api/friends`, { headers: { Cookie: a } });
    const { outgoing } = await aList.json<{ outgoing: { friendshipId: string }[] }>();
    const friendshipId = outgoing[0]!.friendshipId;
    await post(`/api/friends/${friendshipId}/accept`, bCookie);
    await post(`/api/friends/${friendshipId}/block`, a);

    const aAfter = await SELF.fetch(`${BASE}/api/friends`, { headers: { Cookie: a } });
    const aBody = await aAfter.json<{ blocked: { friendshipId: string }[]; friends: unknown[] }>();
    expect(aBody.blocked.map((r) => r.friendshipId)).toContain(friendshipId);
    expect(aBody.friends).toHaveLength(0);

    const bAfter = await SELF.fetch(`${BASE}/api/friends`, { headers: { Cookie: bCookie } });
    const bBody = await bAfter.json<{
      blocked: unknown[];
      friends: unknown[];
      incoming: unknown[];
      outgoing: unknown[];
    }>();
    expect(bBody.blocked).toHaveLength(0);
    expect(bBody.friends).toHaveLength(0);
  });

  it('the 11th invite in a day is rate limited', async () => {
    const inviter = await signUpAndVerify('rate-limited@example.com', 'Limited');
    for (let i = 0; i < 10; i++) {
      const res = await post('/api/friends/invite', inviter, { email: `bulk-${i}@example.com` });
      expect(res.status).toBe(200);
    }
    const eleventh = await post('/api/friends/invite', inviter, { email: 'bulk-10@example.com' });
    expect(eleventh.status).toBe(429);
    const body = await eleventh.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('rate/limited');
  });

  it('requires auth', async () => {
    const res = await SELF.fetch(`${BASE}/api/friends`);
    expect(res.status).toBe(401);
  });
});
