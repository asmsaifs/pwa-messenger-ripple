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

describe('GET/PATCH /api/me', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET returns the bootstrapped profile', async () => {
    const cookie = await signUpAndVerify('me-get@example.com', 'Ada Lovelace');
    const res = await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = await res.json<{
      user: { email: string; emailVerified: boolean };
      profile: { displayName: string };
    }>();
    expect(body.user.email).toBe('me-get@example.com');
    expect(body.user.emailVerified).toBe(true);
    expect(body.profile.displayName).toBe('Ada Lovelace');
  });

  it('PATCH updates displayName and statusText', async () => {
    const cookie = await signUpAndVerify('me-patch@example.com', 'Ada Lovelace');
    const res = await SELF.fetch(`${BASE}/api/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: ORIGIN },
      body: JSON.stringify({ displayName: 'Ada L.', statusText: 'busy' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ displayName: string; statusText: string | null }>();
    expect(body.displayName).toBe('Ada L.');
    expect(body.statusText).toBe('busy');
  });

  it('PATCH rejects an empty displayName', async () => {
    const cookie = await signUpAndVerify('me-patch-invalid@example.com', 'Ada Lovelace');
    const res = await SELF.fetch(`${BASE}/api/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: ORIGIN },
      body: JSON.stringify({ displayName: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('PATCH without a session is unauthenticated', async () => {
    const res = await SELF.fetch(`${BASE}/api/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ displayName: 'nope' }),
    });
    expect(res.status).toBe(401);
  });
});
