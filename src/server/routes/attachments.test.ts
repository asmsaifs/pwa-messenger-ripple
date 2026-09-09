import { env, SELF } from 'cloudflare:test';
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

async function makeFriendsWithConversation(prefix: string) {
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

// A 1x1 PNG — real magic bytes, not just a plausible-looking prefix, so the
// sniffer in src/server/lib/magic-bytes.ts actually recognizes it.
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

async function signAndUpload(
  cookie: string,
  conversationId: string,
  opts: { contentType?: string; bytes?: Uint8Array; size?: number } = {},
) {
  const bytes = opts.bytes ?? PNG_BYTES;
  const signRes = await post('/api/attachments/sign', cookie, {
    conversationId,
    contentType: opts.contentType ?? 'image/png',
    size: opts.size ?? bytes.length,
    name: 'photo.png',
    kind: 'image',
  });
  const { attachmentId, key } = await signRes.json<{ attachmentId: string; key: string }>();
  // The presigned PUT URL points at a real R2 S3 endpoint that only exists
  // for a real bucket (wrangler.jsonc's comment on `r2_buckets`) — tests
  // write directly through the binding instead, exactly like `/complete`'s
  // own HEAD/GET do, so this exercises the same object the route reads.
  await env.MEDIA.put(key, bytes);
  return { attachmentId, signRes };
}

describe('attachments routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POST /sign: member gets a presigned PUT url', async () => {
    const { conversationId, a } = await makeFriendsWithConversation('att-sign');
    const res = await post('/api/attachments/sign', a, {
      conversationId,
      contentType: 'image/png',
      size: PNG_BYTES.length,
      name: 'photo.png',
      kind: 'image',
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ attachmentId: string; uploadUrl: string; key: string }>();
    expect(body.uploadUrl).toContain(body.key);
  });

  it('POST /sign: a stranger gets not-found', async () => {
    const { conversationId } = await makeFriendsWithConversation('att-sign-stranger');
    const stranger = await signUpAndVerify('att-sign-stranger-x@example.com', 'X');
    const res = await post('/api/attachments/sign', stranger, {
      conversationId,
      contentType: 'image/png',
      size: 1024,
      name: 'photo.png',
      kind: 'image',
    });
    expect(res.status).toBe(404);
  });

  it('POST /sign: oversize is rejected', async () => {
    const { conversationId, a } = await makeFriendsWithConversation('att-sign-big');
    const res = await post('/api/attachments/sign', a, {
      conversationId,
      contentType: 'image/png',
      size: 26_214_401,
      name: 'huge.png',
      kind: 'image',
    });
    expect(res.status).toBe(413);
  });

  it('POST /:id/complete: sniffs real bytes and marks ready', async () => {
    const { conversationId, a } = await makeFriendsWithConversation('att-complete');
    const { attachmentId } = await signAndUpload(a, conversationId);

    const res = await post(`/api/attachments/${attachmentId}/complete`, a, {
      width: 1,
      height: 1,
    });
    expect(res.status).toBe(200);
    const { attachment } = await res.json<{ attachment: { status: string; mimeType: string } }>();
    expect(attachment.status).toBe('ready');
    expect(attachment.mimeType).toBe('image/png');
  });

  it('POST /:id/complete: a .png that is actually HTML is rejected (docs/07 E2E #5)', async () => {
    const { conversationId, a } = await makeFriendsWithConversation('att-mismatch');
    const html = new TextEncoder().encode('<html><body>gotcha</body></html>');
    const { attachmentId } = await signAndUpload(a, conversationId, {
      bytes: html,
      size: html.length,
    });

    const res = await post(`/api/attachments/${attachmentId}/complete`, a, {});
    expect(res.status).toBe(422);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('upload/mismatch');
  });

  it('POST /:id/complete: only the uploader may complete it', async () => {
    const { conversationId, a, b } = await makeFriendsWithConversation('att-complete-peer');
    const { attachmentId } = await signAndUpload(a, conversationId);

    const res = await post(`/api/attachments/${attachmentId}/complete`, b, {});
    expect(res.status).toBe(404);
  });

  it('GET /:id/url: member gets a presigned GET only once ready', async () => {
    const { conversationId, a, b } = await makeFriendsWithConversation('att-url');
    const { attachmentId } = await signAndUpload(a, conversationId);

    const pendingRes = await SELF.fetch(`${BASE}/api/attachments/${attachmentId}/url`, {
      headers: { Cookie: b },
    });
    expect(pendingRes.status).toBe(404);

    await post(`/api/attachments/${attachmentId}/complete`, a, {});
    const readyRes = await SELF.fetch(`${BASE}/api/attachments/${attachmentId}/url`, {
      headers: { Cookie: b },
    });
    expect(readyRes.status).toBe(200);
    const { url } = await readyRes.json<{ url: string }>();
    expect(url).toContain('X-Amz-Signature');
  });

  it('GET /:id/url: voice attachments carry durationMs/waveform so the receiver renders without decoding', async () => {
    const { conversationId, a, b } = await makeFriendsWithConversation('att-url-voice');
    // A real EBML/WebM header — audio/webm's magic-bytes signature.
    const WEBM_BYTES = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
    const signRes = await post('/api/attachments/sign', a, {
      conversationId,
      contentType: 'audio/webm',
      size: WEBM_BYTES.length,
      name: 'voice.webm',
      kind: 'voice',
    });
    const { attachmentId, key } = await signRes.json<{ attachmentId: string; key: string }>();
    await env.MEDIA.put(key, WEBM_BYTES);
    await post(`/api/attachments/${attachmentId}/complete`, a, {
      durationMs: 4200,
      waveform: JSON.stringify([1, 2, 3]),
    });

    const res = await SELF.fetch(`${BASE}/api/attachments/${attachmentId}/url`, {
      headers: { Cookie: b },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ durationMs: number | null; waveform: string | null }>();
    expect(body.durationMs).toBe(4200);
    expect(body.waveform).not.toBeNull();
    expect(JSON.parse(body.waveform as string)).toEqual([1, 2, 3]);
  });

  it('GET /:id/url: a stranger gets not-found', async () => {
    const { conversationId, a } = await makeFriendsWithConversation('att-url-stranger');
    const { attachmentId } = await signAndUpload(a, conversationId);
    await post(`/api/attachments/${attachmentId}/complete`, a, {});
    const stranger = await signUpAndVerify('att-url-stranger-x@example.com', 'X');

    const res = await SELF.fetch(`${BASE}/api/attachments/${attachmentId}/url`, {
      headers: { Cookie: stranger },
    });
    expect(res.status).toBe(404);
  });

  it('requires auth', async () => {
    const res = await post('/api/attachments/sign', '', {
      conversationId: 'x',
      contentType: 'image/png',
      size: 1,
      name: 'a.png',
      kind: 'image',
    });
    expect(res.status).toBe(401);
  });
});
