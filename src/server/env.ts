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
  // RateLimiterDO (M5, docs/02 §3) — abuse controls (docs/05 §8).
  RATE_LIMITER: DurableObjectNamespace<import('../durable/RateLimiterDO').RateLimiterDO>;
  // ConversationDO (M6, docs/01 §6) — messages/receipts/typing SQLite, one
  // instance per conversation.
  CONVERSATION: DurableObjectNamespace<import('../durable/ConversationDO').ConversationDO>;
  // UserDO (M7, docs/01 §6, docs/02 §3) — personal event bus, presence,
  // unread counts; one instance per user.
  USER: DurableObjectNamespace<import('../durable/UserDO').UserDO>;
  // Cloudflare Email Sending (M5) — invite emails. Optional: the `from`
  // domain isn't onboarded in every env (docs/08), so local dev/tests still
  // typecheck and fall back to a log line in src/server/lib/mail.ts.
  EMAIL?: SendEmail;
  // R2 (M9, docs/02 §4) — attachment bytes. Binding for server-side HEAD/GET/
  // delete (never a public URL, docs/05 §7); the S3-compatible credentials
  // below are for presigning PUT/GET only (aws4fetch, src/server/lib/r2-presign.ts) —
  // R2Bucket itself has no presign method.
  MEDIA: R2Bucket;
  // The `R2Bucket` binding has no way to read back its own bucket name at
  // runtime, but presigning needs it in the S3 endpoint path — kept in sync
  // with wrangler.jsonc's `r2_buckets[0].bucket_name` by hand (it changes once
  // per environment, not per deploy).
  MEDIA_BUCKET_NAME: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  // Web Push VAPID keypair (M12, docs/05 §8/§10, docs/08 §3) — signs the
  // `Authorization: vapid ...` JWT (src/server/lib/vapid.ts). Never rotate
  // without a 2-key rollover (docs/05 §10): every existing subscription
  // would otherwise start 403ing. `VAPID_PUBLIC_KEY` is not secret by nature
  // (docs/05 §5: "the client bundle holds only the VAPID *public* key") but
  // both live as `wrangler secret put` values (docs/08 §3) since the client
  // gets its copy via the build-time `VITE_VAPID_PUBLIC_KEY` var instead —
  // this one is only what the Worker signs with server-side.
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  // `push-queue` producer binding (M12, docs/03 §4) — ConversationDO/friend
  // routes enqueue here; `queue()` in index.ts consumes it via
  // src/server/push/consumer.ts. `PushJob` is `unknown` at the binding level
  // (Cloudflare's `Queue<Body>` generic just types `.send`'s argument) — the
  // consumer validates the real shape with `pushJobSchema` on the way out.
  PUSH_QUEUE: Queue<unknown>;
  // CallDO (M13, docs/01 §6) — signaling relay + call state machine, one
  // instance per call.
  CALL: DurableObjectNamespace<import('../durable/CallDO').CallDO>;
  // Cloudflare Realtime TURN credential minting (M13, docs/03 §1, docs/05
  // §6/§10) — `TURN_KEY_ID` identifies the TURN key set, `TURN_API_TOKEN` is
  // the bearer credential for `POST /v1/turn/keys/:id/credentials/generate`.
  // Neither reaches client code (CLAUDE.md hard rule 6); rotate quarterly.
  TURN_KEY_ID: string;
  TURN_API_TOKEN: string;
  // Per-user ICE credential cache (docs/02 §6: `ice:{userId}`, TTL
  // `ttl-300`s) so a page with several call attempts in a session doesn't
  // re-mint TURN creds on every `GET /api/turn`.
  ICE_KV: KVNamespace;
  // Analytics Engine (M13, docs/07 §8) — one `call_metrics` data point per
  // call end: blobs [end_reason, relayed, region], doubles [setup_ms,
  // duration_s, avg_rtt_ms, loss_pct], index = hashed user id.
  ANALYTICS: AnalyticsEngineDataset;
  // `export-queue` producer binding (M15, docs/03 "Data") — mirrors
  // PUSH_QUEUE's shape; src/server/export/consumer.ts validates the real
  // job shape with `exportJobSchema` on the way out.
  EXPORT_QUEUE: Queue<unknown>;
  // Sentry (M15, docs/05 §10 secrets inventory). Optional: absent in local
  // dev/tests, where error reporting just no-ops (src/server/lib/sentry.ts).
  SENTRY_DSN?: string;
}
