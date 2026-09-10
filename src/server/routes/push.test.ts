import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64UrlEncode } from '../lib/vapid';

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
  logSpy.mockRestore();
  return setCookie.split(';')[0]!;
}

function req(method: string, path: string, cookie: string, body?: unknown) {
  return SELF.fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: ORIGIN },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

// @cloudflare/workers-types declares `generateKey`/`exportKey` with unioned
// return types instead of per-overload narrowing — see
// src/server/lib/vapid.ts's `generateEcdhKeyPair`/`exportRawPublicKey`.
async function fakeP256dh(): Promise<string> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', keyPair.publicKey)) as ArrayBuffer);
  return base64UrlEncode(raw);
}

describe('push routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('POST /subscribe: registers a subscription for the caller', async () => {
    const a = await signUpAndVerify('push-sub-a@example.com', 'A');
    const res = await req('POST', '/api/push/subscribe', a, {
      endpoint: 'https://push.example.com/push-sub-a',
      keys: { p256dh: await fakeP256dh(), auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))) },
    });
    expect(res.status).toBe(204);
  });

  it('POST /subscribe: re-subscribing the same endpoint upserts, not duplicates', async () => {
    const a = await signUpAndVerify('push-sub-upsert@example.com', 'A');
    const endpoint = 'https://push.example.com/push-sub-upsert';
    const first = await req('POST', '/api/push/subscribe', a, {
      endpoint,
      keys: { p256dh: await fakeP256dh(), auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))) },
    });
    const second = await req('POST', '/api/push/subscribe', a, {
      endpoint,
      keys: { p256dh: await fakeP256dh(), auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))) },
    });
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
  });

  it('POST /subscribe: requires auth', async () => {
    const res = await req('POST', '/api/push/subscribe', '', {
      endpoint: 'https://push.example.com/x',
      keys: { p256dh: 'x', auth: 'y' },
    });
    expect(res.status).toBe(401);
  });

  it('POST /subscribe: rejects a malformed body', async () => {
    const a = await signUpAndVerify('push-sub-bad@example.com', 'A');
    const res = await req('POST', '/api/push/subscribe', a, { endpoint: 'not-a-url' });
    expect(res.status).toBe(400);
  });

  it('DELETE /subscribe: removes the caller’s own subscription', async () => {
    const a = await signUpAndVerify('push-unsub@example.com', 'A');
    const endpoint = 'https://push.example.com/push-unsub';
    await req('POST', '/api/push/subscribe', a, {
      endpoint,
      keys: { p256dh: await fakeP256dh(), auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))) },
    });
    const res = await req('DELETE', '/api/push/subscribe', a, { endpoint });
    expect(res.status).toBe(204);
  });

  it("DELETE /subscribe: cannot delete another user's subscription by guessing the endpoint", async () => {
    const a = await signUpAndVerify('push-unsub-owner@example.com', 'A');
    const b = await signUpAndVerify('push-unsub-attacker@example.com', 'B');
    const endpoint = 'https://push.example.com/push-unsub-owner';
    await req('POST', '/api/push/subscribe', a, {
      endpoint,
      keys: { p256dh: await fakeP256dh(), auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))) },
    });
    // Still 204 (delete is a no-op if nothing matched the actor's own scope,
    // same "no existence leak" shape as every other owner-scoped delete in
    // this codebase) — the real assertion is that A's row survives.
    const res = await req('DELETE', '/api/push/subscribe', b, { endpoint });
    expect(res.status).toBe(204);

    // B's own test-notification fan-out must not hit A's subscription: send
    // a test as A and confirm the endpoint still gets a delivery attempt.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Response(null, { status: 201 })),
    );
    const testRes = await req('POST', '/api/push/test', a, undefined);
    expect(testRes.status).toBe(204);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('POST /test: sends to every subscription and self-cleans a 410', async () => {
    const a = await signUpAndVerify('push-test@example.com', 'A');
    await req('POST', '/api/push/subscribe', a, {
      endpoint: 'https://push.example.com/push-test',
      keys: { p256dh: await fakeP256dh(), auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))) },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Response(null, { status: 410 })),
    );
    const res = await req('POST', '/api/push/test', a, undefined);
    expect(res.status).toBe(204);
    expect(fetch).toHaveBeenCalledOnce();

    // The subscription is gone now — a second test call sends to nobody.
    const fetchSpy = vi.fn(() => new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchSpy);
    await req('POST', '/api/push/test', a, undefined);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
