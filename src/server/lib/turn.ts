import type { Env } from '../env';
import type { IceServer } from '../../shared/calls';

// Cloudflare Realtime TURN credential minting (docs/01 §4.3, docs/03 §1,
// docs/05 §6/§10): "ICE servers from GET /api/turn — HMAC creds minted
// server-side, 1h TTL, cached client-side for `ttl-300`s." `TURN_API_TOKEN`
// never reaches client code (CLAUDE.md hard rule 6) — this is the only place
// it's read.
const TURN_TTL_SECONDS = 60 * 60;
const CACHE_MARGIN_SECONDS = 300;

type TurnCredentialsResponse = {
  iceServers: IceServer | IceServer[];
};

// Real STUN-only fallback (no TURN relay) for local dev without a Realtime
// TURN key set — enough to exercise same-network calls, not the relay path
// (docs/07 §4's nightly relay job needs real creds).
const STUN_FALLBACK: IceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

async function mintTurnCredentials(env: Env): Promise<IceServer[]> {
  if (!env.TURN_API_TOKEN || env.TURN_API_TOKEN === 'dev-only-change-me') {
    return STUN_FALLBACK;
  }
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.TURN_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
    },
  );
  if (!res.ok) {
    throw new Error(`TURN credential mint failed: ${res.status}`);
  }
  const json: TurnCredentialsResponse = await res.json();
  return Array.isArray(json.iceServers) ? json.iceServers : [json.iceServers];
}

type CachedIce = { iceServers: IceServer[]; mintedAt: number };

// Per-user cache in `ICE_KV` (docs/02 §6: `ice:{userId}`), expiring `ttl-300`s
// after mint so a client never gets handed creds within 5 minutes of expiry.
export async function getIceServersForUser(
  env: Env,
  userId: string,
): Promise<{ iceServers: IceServer[]; ttlSeconds: number }> {
  const key = `ice:${userId}`;
  const cached = await env.ICE_KV.get<CachedIce>(key, 'json');
  const now = Date.now();
  if (cached) {
    const remainingSeconds = TURN_TTL_SECONDS - Math.floor((now - cached.mintedAt) / 1000);
    if (remainingSeconds > CACHE_MARGIN_SECONDS) {
      return { iceServers: cached.iceServers, ttlSeconds: remainingSeconds };
    }
  }

  const iceServers = await mintTurnCredentials(env);
  const entry: CachedIce = { iceServers, mintedAt: now };
  await env.ICE_KV.put(key, JSON.stringify(entry), {
    expirationTtl: TURN_TTL_SECONDS,
  });
  return { iceServers, ttlSeconds: TURN_TTL_SECONDS - CACHE_MARGIN_SECONDS };
}
