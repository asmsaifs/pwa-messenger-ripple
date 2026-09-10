// Web Push: VAPID (RFC 8292) JWT signing + `aes128gcm` payload encryption
// (RFC 8291, which layers on RFC 8188's content-encoding) — all via native
// WebCrypto, no `web-push` npm package (that library assumes Node's
// `crypto`/Buffer APIs the Workers runtime doesn't provide the same way, and
// CLAUDE.md rule 11 requires a justification for any new dependency; the
// Workers runtime implements every WebCrypto primitive this needs — ECDSA,
// ECDH, HKDF, AES-GCM — so a dependency isn't warranted here).
//
// This is the one file in M12 where a subtly wrong byte offset silently
// produces "push accepted, notification never shown" instead of a visible
// error, so every step below cites the RFC section it implements.
import type { Env } from '../env';

export type PushSubscriptionKeys = { endpoint: string; p256dh: string; auth: string };

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const binary = atob(padded + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// The public key is stored/transmitted as the raw uncompressed EC point
// (`0x04 || X(32) || Y(32)`, 65 bytes) — the same format `PushSubscription.
// getKey('p256dh')` and `npx web-push generate-vapid-keys` both use, so
// `VAPID_PUBLIC_KEY` interoperates with either. `x`/`y` are split out of it
// on demand (below) rather than stored separately, since the raw point
// already contains both.
async function importVapidSigningKey(env: Env): Promise<CryptoKey> {
  const publicBytes = base64UrlDecode(env.VAPID_PUBLIC_KEY);
  if (publicBytes.length !== 65 || publicBytes[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY is not a raw uncompressed P-256 point');
  }
  const x = publicBytes.slice(1, 33);
  const y = publicBytes.slice(33, 65);
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    d: env.VAPID_PRIVATE_KEY,
    x: base64UrlEncode(x),
    y: base64UrlEncode(y),
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
  ]);
}

// RFC 8292 §2: a short-lived JWT, `aud` = the push service's origin, `exp`
// within 24h (12h here, comfortably under that and under the 5s/10s batch
// window this is always used from), `sub` a contact URI — an `https:` URL is
// valid per the RFC's `mailto:`-or-URL rule, and reusing `APP_BASE_URL` means
// this doesn't need its own secret (a documented deviation from docs/08 §3,
// which doesn't list a `VAPID_SUBJECT` secret at all).
export async function signVapidJwt(env: Env, audience: string): Promise<string> {
  const header = { typ: 'JWT', alg: 'ES256' };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    aud: audience,
    exp: now + 12 * 60 * 60,
    sub: env.APP_BASE_URL,
  };
  const encoder = new TextEncoder();
  const unsigned = `${base64UrlEncode(encoder.encode(JSON.stringify(header)))}.${base64UrlEncode(
    encoder.encode(JSON.stringify(claims)),
  )}`;
  const key = await importVapidSigningKey(env);
  // WebCrypto's ECDSA signature output is the raw `r || s` concatenation
  // (IEEE P1363), which is exactly the JWS ES256 signature encoding — unlike
  // most other ECDSA tooling (OpenSSL, Node's `crypto.sign`), which defaults
  // to DER and needs a conversion step this therefore doesn't need.
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    encoder.encode(unsigned),
  );
  return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
}

// docs/03 §4: "Authorization: vapid t=<jwt>, k=<public key>" per RFC 8292 §3.
export async function vapidAuthorizationHeader(env: Env, endpoint: string): Promise<string> {
  const audience = new URL(endpoint).origin;
  const jwt = await signVapidJwt(env, audience);
  return `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`;
}

// ── RFC 8291 payload encryption (`aes128gcm`, layered on RFC 8188) ─────────
// `@cloudflare/workers-types`' `SubtleCrypto` is less precise than lib.dom's:
// `generateKey`/`exportKey` are declared with a single unioned return type
// (`CryptoKey | CryptoKeyPair`, `ArrayBuffer | JsonWebKey`) instead of
// per-overload narrowing, so every call site needs an explicit assertion —
// these two helpers centralize that instead of repeating it inline.
async function generateEcdhKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;
}

async function exportRawPublicKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array((await crypto.subtle.exportKey('raw', key)) as ArrayBuffer);
}

// Same workers-types gap, a different shape: the ECDH `deriveBits` algorithm
// dictionary's peer-public-key field is declared as `$public` there (not the
// real Web Crypto / RFC-standard `public` the Workers runtime actually reads
// off the object at call time) — a long-standing generator quirk, not a
// runtime rename. Cast through `unknown` rather than send a literal `$public`
// key the runtime would silently ignore.
async function deriveEcdhSharedSecret(
  peerPublicKey: CryptoKey,
  privateKey: CryptoKey,
  lengthBits: number,
): Promise<Uint8Array> {
  const algorithm = { name: 'ECDH', public: peerPublicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  return new Uint8Array(await crypto.subtle.deriveBits(algorithm, privateKey, lengthBits));
}

async function hkdf(
  keyMaterial: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  lengthBits: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyMaterial, 'HKDF', false, ['deriveBits']);
  // WebCrypto's single-shot HKDF (`deriveBits`) performs RFC 5869
  // extract(salt, ikm) then expand(prk, info, length) as one call — exactly
  // RFC 8291's two derivation steps below, each just a different
  // (salt, ikm, info, length) tuple fed through the same primitive.
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    lengthBits,
  );
  return new Uint8Array(bits);
}

const textEncoder = new TextEncoder();

// One AEAD record, `aes128gcm` content-coding (RFC 8188 §2), header:
// `salt(16) || rs(4, big-endian) || idlen(1) || keyid(idlen)`. The whole
// push payload is small enough to always fit one record (`rs` just needs to
// be ≥ this record's ciphertext length, which the decoder then reads as "one
// record, no more follow" — see RFC 8188 §2's "last record" note).
export async function encryptPushPayload(
  payloadJson: unknown,
  subscription: PushSubscriptionKeys,
): Promise<Uint8Array> {
  const receiverPublicRaw = base64UrlDecode(subscription.p256dh);
  const authSecret = base64UrlDecode(subscription.auth);
  if (receiverPublicRaw.length !== 65 || receiverPublicRaw[0] !== 0x04) {
    throw new Error('subscription p256dh is not a raw uncompressed P-256 point');
  }

  const receiverPublicKey = await crypto.subtle.importKey(
    'raw',
    receiverPublicRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ephemeralKeyPair = await generateEcdhKeyPair();
  const ephemeralPublicRaw = await exportRawPublicKey(ephemeralKeyPair.publicKey);
  const ecdhSecret = await deriveEcdhSharedSecret(receiverPublicKey, ephemeralKeyPair.privateKey, 256);

  // RFC 8291 §3.3: derive the shared "input keying material" from the ECDH
  // secret, salted by the subscription's `auth` secret, bound to both public
  // keys via `info` (prevents a key-confusion swap between the two points).
  const keyInfo = concatBytes(
    textEncoder.encode('WebPush: info\0'),
    receiverPublicRaw,
    ephemeralPublicRaw,
  );
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 256);

  // RFC 8188 §2.1: a fresh random salt per message derives the actual
  // content-encryption key and nonce from that IKM.
  const recordSalt = crypto.getRandomValues(new Uint8Array(16));
  const cekBytes = await hkdf(
    ikm,
    recordSalt,
    concatBytes(textEncoder.encode('Content-Encoding: aes128gcm\0')),
    128,
  );
  const nonce = await hkdf(
    ikm,
    recordSalt,
    concatBytes(textEncoder.encode('Content-Encoding: nonce\0')),
    96,
  );

  // RFC 8188 §2: plaintext padded with a delimiter octet — `0x02` marks this
  // as the final (and only) record; no further padding needed for a payload
  // this small.
  const plaintext = concatBytes(
    textEncoder.encode(JSON.stringify(payloadJson)),
    Uint8Array.of(0x02),
  );

  const cek = await crypto.subtle.importKey('raw', cekBytes, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cek, plaintext),
  );

  const recordSize = ciphertext.length; // single record ⇒ header's `rs` just needs to cover it
  const header = new Uint8Array(16 + 4 + 1 + ephemeralPublicRaw.length);
  header.set(recordSalt, 0);
  new DataView(header.buffer).setUint32(16, recordSize, false);
  header[20] = ephemeralPublicRaw.length;
  header.set(ephemeralPublicRaw, 21);

  return concatBytes(header, ciphertext);
}

export { base64UrlDecode, base64UrlEncode };
