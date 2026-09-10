import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  encryptPushPayload,
  signVapidJwt,
  vapidAuthorizationHeader,
} from './vapid';

// Independent (re-implemented, not imported) HKDF/ECDH/AES-GCM decrypt of
// `encryptPushPayload`'s output, mirroring RFC 8291 from the *receiver's*
// side — a real browser's Push API decrypts exactly this way before handing
// the plaintext to the `push` event. Deliberately not sharing code with
// src/server/lib/vapid.ts's implementation: importing its internals here
// would let a shared bug (e.g. a swapped info string) cancel itself out and
// still pass.
async function hkdf(
  keyMaterial: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  lengthBits: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyMaterial, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    lengthBits,
  );
  return new Uint8Array(bits);
}

// @cloudflare/workers-types declares `generateKey`/`exportKey` with unioned
// return types instead of per-overload narrowing (see vapid.ts's
// `generateEcdhKeyPair`/`exportRawPublicKey`) — same cast, test-local copy so
// this file's "independent decrypt" stays uncoupled from vapid.ts's code.
async function generateSubscriberKeyPair(): Promise<{
  keyPair: CryptoKeyPair;
  publicRaw: Uint8Array;
}> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;
  const publicRaw = new Uint8Array(
    (await crypto.subtle.exportKey('raw', keyPair.publicKey)) as ArrayBuffer,
  );
  return { keyPair, publicRaw };
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function decryptAsSubscriber(
  encrypted: Uint8Array,
  subscriberKeyPair: CryptoKeyPair,
  subscriberPublicRaw: Uint8Array,
  authSecret: Uint8Array,
): Promise<unknown> {
  const view = new DataView(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength);
  const salt = encrypted.slice(0, 16);
  const idlen = encrypted[20]!;
  const senderPublicRaw = encrypted.slice(21, 21 + idlen);
  const ciphertext = encrypted.slice(21 + idlen);
  void view; // rs field (bytes 16-19) isn't needed to decrypt a single record

  const senderPublicKey = await crypto.subtle.importKey(
    'raw',
    senderPublicRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  // `$public` vs `public`: see src/server/lib/vapid.ts's `deriveEcdhSharedSecret`
  // comment — @cloudflare/workers-types mis-names this field; the runtime
  // still reads the real Web Crypto `public` key.
  const algorithm = { name: 'ECDH', public: senderPublicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(algorithm, subscriberKeyPair.privateKey, 256),
  );

  const encoder = new TextEncoder();
  const keyInfo = concat(encoder.encode('WebPush: info\0'), subscriberPublicRaw, senderPublicRaw);
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 256);

  const cekBytes = await hkdf(ikm, salt, encoder.encode('Content-Encoding: aes128gcm\0'), 128);
  const nonce = await hkdf(ikm, salt, encoder.encode('Content-Encoding: nonce\0'), 96);

  const cek = await crypto.subtle.importKey('raw', cekBytes, 'AES-GCM', false, ['decrypt']);
  const plaintextWithDelimiter = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cek, ciphertext),
  );
  // Strip the RFC 8188 §2 padding delimiter (`0x02`, last/only record).
  expect(plaintextWithDelimiter.at(-1)).toBe(0x02);
  const plaintext = plaintextWithDelimiter.slice(0, -1);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

describe('vapid', () => {
  describe('signVapidJwt / vapidAuthorizationHeader', () => {
    it('produces a JWT that verifies against the same VAPID public key', async () => {
      const jwt = await signVapidJwt(env, 'https://push.example.com');
      const [headerB64, payloadB64, sigB64] = jwt.split('.');
      expect(headerB64).toBeDefined();
      expect(payloadB64).toBeDefined();
      expect(sigB64).toBeDefined();

      const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64!))) as {
        alg: string;
        typ: string;
      };
      expect(header).toEqual({ alg: 'ES256', typ: 'JWT' });

      const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64!))) as {
        aud: string;
        sub: string;
        exp: number;
      };
      expect(payload.aud).toBe('https://push.example.com');
      expect(payload.sub).toBe(env.APP_BASE_URL);
      expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

      // Verify with the *public* key, independent of the signing path —
      // proves the WebCrypto ECDSA output is real IEEE-P1363 r||s (JOSE
      // format), not e.g. an unconverted DER signature.
      const publicRaw = base64UrlDecode(env.VAPID_PUBLIC_KEY);
      const publicKey = await crypto.subtle.importKey(
        'raw',
        publicRaw,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
      const signed = `${headerB64}.${payloadB64}`;
      const ok = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        base64UrlDecode(sigB64!),
        new TextEncoder().encode(signed),
      );
      expect(ok).toBe(true);
    });

    it('rejects a signature under a tampered payload', async () => {
      const jwt = await signVapidJwt(env, 'https://push.example.com');
      const [headerB64, , sigB64] = jwt.split('.');
      const tamperedPayload = base64UrlEncode(
        new TextEncoder().encode(JSON.stringify({ aud: 'https://evil.example.com', sub: 'x', exp: 0 })),
      );
      const publicRaw = base64UrlDecode(env.VAPID_PUBLIC_KEY);
      const publicKey = await crypto.subtle.importKey(
        'raw',
        publicRaw,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
      const ok = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        base64UrlDecode(sigB64!),
        new TextEncoder().encode(`${headerB64}.${tamperedPayload}`),
      );
      expect(ok).toBe(false);
    });

    it('builds a "vapid t=..., k=..." Authorization header scoped to the endpoint origin', async () => {
      const header = await vapidAuthorizationHeader(env, 'https://fcm.googleapis.com/wp/abc123');
      expect(header).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
      expect(header).toContain(`k=${env.VAPID_PUBLIC_KEY}`);
    });
  });

  describe('encryptPushPayload', () => {
    it('round-trips through an independent RFC 8291 decrypt', async () => {
      const { keyPair: subscriberKeyPair, publicRaw: subscriberPublicRaw } =
        await generateSubscriberKeyPair();
      const authSecret = crypto.getRandomValues(new Uint8Array(16));

      const payload = { type: 'message', title: 'Ripple', body: 'Hello!', tag: 'msg-1', data: { url: '/c/1' } };
      const encrypted = await encryptPushPayload(payload, {
        endpoint: 'https://push.example.com/x',
        p256dh: base64UrlEncode(subscriberPublicRaw),
        auth: base64UrlEncode(authSecret),
      });

      const decrypted = await decryptAsSubscriber(
        encrypted,
        subscriberKeyPair,
        subscriberPublicRaw,
        authSecret,
      );
      expect(decrypted).toEqual(payload);
    });

    it('produces a different ciphertext (fresh salt + ephemeral key) each call', async () => {
      const { publicRaw: subscriberPublicRaw } = await generateSubscriberKeyPair();
      const authSecret = crypto.getRandomValues(new Uint8Array(16));
      const subscription = {
        endpoint: 'https://push.example.com/x',
        p256dh: base64UrlEncode(subscriberPublicRaw),
        auth: base64UrlEncode(authSecret),
      };
      const a = await encryptPushPayload({ msg: 'hi' }, subscription);
      const b = await encryptPushPayload({ msg: 'hi' }, subscription);
      expect(base64UrlEncode(a)).not.toBe(base64UrlEncode(b));
    });

    it('a wrong auth secret fails to decrypt (AEAD tag mismatch)', async () => {
      const { keyPair: subscriberKeyPair, publicRaw: subscriberPublicRaw } =
        await generateSubscriberKeyPair();
      const authSecret = crypto.getRandomValues(new Uint8Array(16));
      const wrongAuthSecret = crypto.getRandomValues(new Uint8Array(16));

      const encrypted = await encryptPushPayload(
        { msg: 'hi' },
        {
          endpoint: 'https://push.example.com/x',
          p256dh: base64UrlEncode(subscriberPublicRaw),
          auth: base64UrlEncode(authSecret),
        },
      );

      await expect(
        decryptAsSubscriber(encrypted, subscriberKeyPair, subscriberPublicRaw, wrongAuthSecret),
      ).rejects.toThrow();
    });
  });
});
