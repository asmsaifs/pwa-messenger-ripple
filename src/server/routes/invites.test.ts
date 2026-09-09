import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInvitation } from '../repos/friends';
import { hashInviteToken } from '../lib/tokens';

const BASE = 'https://example.com';
const ORIGIN = 'http://localhost:8787';

function extractLoggedUrl(spy: ReturnType<typeof vi.spyOn>, marker: string): string {
  const call = spy.mock.calls.find(([line]) => String(line).includes(marker));
  if (!call) throw new Error(`no logged line matched "${marker}"`);
  const match = String(call[0]).match(/(https?:\/\/\S+)/);
  if (!match) throw new Error('no URL found in logged line');
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

describe('invites routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preview then claim: an unregistered invite becomes an accepted friendship + conversation (E2E #2)', async () => {
    const inviter = await signUpAndVerify('claim-inviter@example.com', 'Ida Inviter');
    const inviterMe = await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: inviter } });
    const inviterId = (await inviterMe.json<{ user: { id: string } }>()).user.id;
    const rawToken = 'e2e-claim-token';
    await createInvitation(
      env,
      { userId: inviterId, sessionId: 's', emailVerified: true },
      { email: 'claim-invitee@example.com', tokenHash: await hashInviteToken(rawToken), expiresAt: Date.now() + 60_000 },
    );

    const previewRes = await SELF.fetch(`${BASE}/api/invites/${rawToken}`);
    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json<{ inviterName: string }>();
    expect(preview.inviterName).toBe('Ida Inviter');

    const inviteeCookie = await signUpAndVerify('claim-invitee@example.com', 'Ivy Invitee');
    const claimRes = await SELF.fetch(`${BASE}/api/invites/${rawToken}/claim`, {
      method: 'POST',
      headers: { Cookie: inviteeCookie, Origin: ORIGIN },
    });
    expect(claimRes.status).toBe(200);
    const claimed = await claimRes.json<{ friendshipId: string; conversationId: string }>();
    expect(claimed.friendshipId).toBeTruthy();
    expect(claimed.conversationId).toBeTruthy();

    const inviteeFriends = await SELF.fetch(`${BASE}/api/friends`, {
      headers: { Cookie: inviteeCookie },
    });
    const body = await inviteeFriends.json<{ friends: { displayName: string }[] }>();
    expect(body.friends.map((f) => f.displayName)).toContain('Ida Inviter');

    // Claimed invitations don't stay claimable — the enumeration rule hides
    // the reason (docs/02 §5).
    const secondClaim = await SELF.fetch(`${BASE}/api/invites/${rawToken}/claim`, {
      method: 'POST',
      headers: { Cookie: inviteeCookie, Origin: ORIGIN },
    });
    expect(secondClaim.status).toBe(404);
  });

  it('GET preview 404s for an unknown token', async () => {
    const res = await SELF.fetch(`${BASE}/api/invites/not-a-real-token`);
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('policy/not-found');
  });

  it('claim requires a session', async () => {
    const res = await SELF.fetch(`${BASE}/api/invites/some-token/claim`, {
      method: 'POST',
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(401);
  });

  it('resend and revoke are inviter-only (404 for anyone else)', async () => {
    const inviter = await signUpAndVerify('inv-manage-inviter@example.com', 'Inviter');
    const stranger = await signUpAndVerify('inv-manage-stranger@example.com', 'Stranger');

    await SELF.fetch(`${BASE}/api/friends/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: inviter, Origin: ORIGIN },
      body: JSON.stringify({ email: 'inv-manage-target@example.com' }),
    });
    const list = await SELF.fetch(`${BASE}/api/friends`, { headers: { Cookie: inviter } });
    const { invitations } = await list.json<{ invitations: { id: string }[] }>();
    const invitationId = invitations[0]!.id;

    const strangerResend = await SELF.fetch(`${BASE}/api/invites/${invitationId}/resend`, {
      method: 'POST',
      headers: { Cookie: stranger, Origin: ORIGIN },
    });
    expect(strangerResend.status).toBe(404);

    const ownerDelete = await SELF.fetch(`${BASE}/api/invites/${invitationId}`, {
      method: 'DELETE',
      headers: { Cookie: inviter, Origin: ORIGIN },
    });
    expect(ownerDelete.status).toBe(204);
  });

  it('resend is rate limited to once per 24h per invitation', async () => {
    const inviter = await signUpAndVerify('inv-resend-inviter@example.com', 'Inviter');
    await SELF.fetch(`${BASE}/api/friends/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: inviter, Origin: ORIGIN },
      body: JSON.stringify({ email: 'inv-resend-target@example.com' }),
    });
    const list = await SELF.fetch(`${BASE}/api/friends`, { headers: { Cookie: inviter } });
    const { invitations } = await list.json<{ invitations: { id: string }[] }>();
    const invitationId = invitations[0]!.id;

    const first = await SELF.fetch(`${BASE}/api/invites/${invitationId}/resend`, {
      method: 'POST',
      headers: { Cookie: inviter, Origin: ORIGIN },
    });
    expect(first.status).toBe(204);

    const second = await SELF.fetch(`${BASE}/api/invites/${invitationId}/resend`, {
      method: 'POST',
      headers: { Cookie: inviter, Origin: ORIGIN },
    });
    expect(second.status).toBe(429);
  });
});
