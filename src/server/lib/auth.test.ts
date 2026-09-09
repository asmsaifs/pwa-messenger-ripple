import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

// API-level suite (docs/07 §1: "every route: happy, unauthorized, cross-tenant")
// for the Better Auth wiring itself. Runs against the real handler mounted at
// /api/auth/* — no shortcuts through the D1 rows directly, since the point is
// proving the D1 adapter, KV secondary storage, cookie config, and the
// verify/reset token flows actually work end to end.
//
// Verification/reset links normally go out over email (M5); until then
// `sendVerificationEmail`/`sendResetPassword` just log the link
// (src/server/lib/mail.ts), so tests recover it from a console.log spy.
const BASE = 'https://example.com';
const ORIGIN = 'http://localhost:8787'; // matches wrangler.jsonc APP_BASE_URL

function extractLoggedUrl(spy: ReturnType<typeof vi.spyOn>, marker: string): string {
  const call = spy.mock.calls.find(([line]) => String(line).includes(marker));
  if (!call) throw new Error(`no logged email matched "${marker}"`);
  const match = String(call[0]).match(/(https?:\/\/\S+)/);
  if (!match) throw new Error('no URL found in logged email');
  return match[1]!;
}

function cookieHeaderFrom(res: Response): string {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('response set no cookie');
  return setCookie.split(';')[0]!;
}

async function signUp(email: string, password: string, name = 'Ada Lovelace') {
  return SELF.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email, password, name }),
  });
}

describe('Better Auth wiring (/api/auth/*)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('signup -> verify -> session survives a second request', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const email = 'ada@example.com';

    const signUpRes = await signUp(email, 'correct horse battery staple');
    expect(signUpRes.status).toBe(200);
    // requireEmailVerification means no session yet.
    expect(signUpRes.headers.get('set-cookie')).toBeNull();

    const verifyUrl = extractLoggedUrl(logSpy, 'verify-email');
    const verifyRes = await SELF.fetch(verifyUrl, { redirect: 'manual' });
    expect([200, 302]).toContain(verifyRes.status);
    const cookie = cookieHeaderFrom(verifyRes);
    expect(cookie.startsWith('__Host-ripple.session=')).toBe(true);

    const meRes1 = await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } });
    expect(meRes1.status).toBe(200);
    const body1 = await meRes1.json<{ user: { emailVerified: boolean } }>();
    expect(body1.user.emailVerified).toBe(true);

    // Same cookie, second request — session persists across reload.
    const meRes2 = await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } });
    expect(meRes2.status).toBe(200);
  });

  it('bootstraps a profile row on signup', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const email = 'grace@example.com';
    await signUp(email, 'correct horse battery staple', 'Grace Hopper');

    const verifyUrl = extractLoggedUrl(logSpy, 'verify-email');
    const verifyRes = await SELF.fetch(verifyUrl, { redirect: 'manual' });
    const cookie = cookieHeaderFrom(verifyRes);

    const meRes = await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } });
    const body = await meRes.json<{ profile: { displayName: string } }>();
    expect(body.profile.displayName).toBe('Grace Hopper');
  });

  it('rejects a weak password at signup', async () => {
    const res = await signUp('weak@example.com', 'aaaaaaaaaa');
    expect(res.status).toBe(400);
  });

  it('rejects sign-in before the email is verified', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const email = 'unverified@example.com';
    const password = 'correct horse battery staple';
    await signUp(email, password);

    const res = await SELF.fetch(`${BASE}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ email, password }),
    });
    expect(res.status).toBe(403);
  });

  it('login: correct password succeeds, wrong password fails', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const email = 'turing@example.com';
    const password = 'correct horse battery staple';
    await signUp(email, password);
    const verifyUrl = extractLoggedUrl(logSpy, 'verify-email');
    await SELF.fetch(verifyUrl, { redirect: 'manual' });

    const wrong = await SELF.fetch(`${BASE}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ email, password: 'not the password' }),
    });
    expect(wrong.status).toBe(401);

    const right = await SELF.fetch(`${BASE}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ email, password }),
    });
    expect(right.status).toBe(200);
    expect(right.headers.get('set-cookie')).toMatch(/^__Host-ripple\.session=/);
  });

  it('reset-password: resets and revokes the old session', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const email = 'lovelace2@example.com';
    const oldPassword = 'correct horse battery staple';
    const newPassword = 'another strong passphrase here';
    await signUp(email, oldPassword);
    const verifyUrl = extractLoggedUrl(logSpy, 'verify-email');
    const verifyRes = await SELF.fetch(verifyUrl, { redirect: 'manual' });
    const oldCookie = cookieHeaderFrom(verifyRes);

    await SELF.fetch(`${BASE}/api/auth/request-password-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ email }),
    });
    const resetUrl = extractLoggedUrl(logSpy, 'reset-password');
    const token = new URL(resetUrl).pathname.split('/').pop()!;

    const resetRes = await SELF.fetch(`${BASE}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ newPassword, token }),
    });
    expect(resetRes.status).toBe(200);

    // Old session cookie no longer works.
    const meRes = await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: oldCookie } });
    expect(meRes.status).toBe(401);

    // New password signs in; old one doesn't.
    const oldLogin = await SELF.fetch(`${BASE}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ email, password: oldPassword }),
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await SELF.fetch(`${BASE}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ email, password: newPassword }),
    });
    expect(newLogin.status).toBe(200);
  });

  it('GET /api/me without a session cookie is unauthenticated', async () => {
    const res = await SELF.fetch(`${BASE}/api/me`);
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('auth/unauthenticated');
  });
});
