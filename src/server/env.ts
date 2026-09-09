// Worker bindings, grown one field at a time as milestones add infrastructure
// (Durable Objects in M2/M6+, R2/KV/Queues later — see docs/08 §2).
export interface Env {
  APP_ENV: string;
  APP_BASE_URL: string;
  ASSETS: Fetcher;
  DB: D1Database;
  // Better Auth (M3, docs/05 §2/§10) — signs sessions/tokens; rotating it
  // invalidates every session. Set via `wrangler secret put` in deployed envs,
  // `.dev.vars` locally.
  BETTER_AUTH_SECRET: string;
  // Better Auth's session secondary storage (docs/02 §6: `sess:{token}`).
  SESSIONS_KV: KVNamespace;
  // Cloudflare Turnstile secret (docs/05 §8 signup abuse control). Optional:
  // the captcha plugin only activates when this is set, so local dev/tests
  // don't need a live Turnstile account.
  TURNSTILE_SECRET?: string;
}
