#!/usr/bin/env node
// One-time VAPID keypair generator (docs/08 §4's `npx web-push generate-
// vapid-keys` step, reimplemented so this repo doesn't need the `web-push`
// npm package as a dependency — CLAUDE.md rule 11 requires a justification
// for any new dependency, and the only thing this repo needs from it is this
// one-off script, which Node's built-in `node:crypto` WebCrypto already
// covers). Output is byte-for-byte the same format `web-push` produces
// (base64url: raw uncompressed P-256 point for the public key, raw `d` for
// the private key) and the exact format src/server/lib/vapid.ts expects, so
// the two are interchangeable.
import { webcrypto } from 'node:crypto';

function base64UrlEncode(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const keyPair = await webcrypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
);
const publicRaw = new Uint8Array(await webcrypto.subtle.exportKey('raw', keyPair.publicKey));
const privateJwk = await webcrypto.subtle.exportKey('jwk', keyPair.privateKey);

const publicKey = base64UrlEncode(publicRaw);
const privateKey = privateJwk.d; // JWK's `d` is already base64url-encoded

console.log('VAPID_PUBLIC_KEY=' + publicKey);
console.log('VAPID_PRIVATE_KEY=' + privateKey);
console.log('');
console.log('Server (Worker): wrangler secret put VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY');
console.log('                 (or paste both lines into .dev.vars for local dev)');
console.log('Client (build-time, public key only): set VITE_VAPID_PUBLIC_KEY=' + publicKey);
console.log('                 in .env.local');
