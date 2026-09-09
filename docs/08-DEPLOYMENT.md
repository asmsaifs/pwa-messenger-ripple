# 08 — Environments, Deployment, Ops (Cloudflare)

## 1. Environments
| Env | Worker | D1 | R2 | Domain |
|---|---|---|---|---|
| local | `wrangler dev` (Miniflare: D1, DO, R2, KV, Queues all local) | `ripple-local` | local dir | `localhost:8787` (Vite proxies from 5173) |
| preview | per-PR `wrangler versions upload` | `ripple-staging` | `ripple-media-staging` | `<version>-ripple.workers.dev` |
| staging | env `staging` | `ripple-staging` | `ripple-media-staging` | `staging.ripple.app` |
| prod | env `production` | `ripple-prod` | `ripple-media` | `ripple.app` |

Preview must never bind prod D1/R2. Enforced by using `[env.staging]` / `[env.production]` blocks with distinct `database_id`s — no shared default binding.

## 2. `wrangler.jsonc`
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "ripple",
  "main": "src/server/index.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "./dist/client", "binding": "ASSETS", "not_found_handling": "single-page-application" },
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  "placement": { "mode": "smart" },

  "durable_objects": { "bindings": [
    { "name": "CONVERSATION", "class_name": "ConversationDO" },
    { "name": "USER",         "class_name": "UserDO" },
    { "name": "CALL",         "class_name": "CallDO" },
    { "name": "RATELIMIT",    "class_name": "RateLimiterDO" }
  ]},
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["ConversationDO", "RateLimiterDO"] },
    { "tag": "v2", "new_classes": ["UserDO", "CallDO"] }
  ],

  "d1_databases": [{ "binding": "DB", "database_name": "ripple-local", "database_id": "<id>",
                     "migrations_dir": "migrations" }],
  "r2_buckets":   [{ "binding": "MEDIA", "bucket_name": "ripple-media-local" }],
  "kv_namespaces":[{ "binding": "KV", "id": "<id>" }],
  "queues": {
    "producers": [{ "binding": "PUSH_QUEUE", "queue": "push-queue" }],
    "consumers": [{ "queue": "push-queue", "max_batch_size": 10, "max_batch_timeout": 5,
                    "max_retries": 3, "dead_letter_queue": "push-dlq" }]
  },
  "analytics_engine_datasets": [{ "binding": "METRICS", "dataset": "ripple_call_metrics" }],
  "send_email": [{ "name": "EMAIL", "destination_address": null }],
  "triggers": { "crons": ["*/10 * * * *", "0 * * * *", "0 3 * * *", "0 4 * * *", "*/5 * * * *"] },

  "vars": { "APP_ENV": "local", "APP_BASE_URL": "http://localhost:8787" },

  "env": {
    "staging":    { "vars": { "APP_ENV": "staging",    "APP_BASE_URL": "https://staging.ripple.app" },
                    "routes": [{ "pattern": "staging.ripple.app", "custom_domain": true }],
                    "d1_databases": [{ "binding": "DB", "database_name": "ripple-staging", "database_id": "<id>" }],
                    "r2_buckets":   [{ "binding": "MEDIA", "bucket_name": "ripple-media-staging" }] },
    "production": { "vars": { "APP_ENV": "production", "APP_BASE_URL": "https://ripple.app" },
                    "routes": [{ "pattern": "ripple.app", "custom_domain": true }],
                    "d1_databases": [{ "binding": "DB", "database_name": "ripple-prod", "database_id": "<id>" }],
                    "r2_buckets":   [{ "binding": "MEDIA", "bucket_name": "ripple-media" }] }
  }
}
```
Notes: `new_sqlite_classes` for DOs that use `ctx.storage.sql` — this cannot be changed after deploy, so get it right the first time. `nodejs_compat` is needed by Better Auth. `not_found_handling: single-page-application` replaces the old `_redirects` SPA fallback.

## 3. Secrets
```bash
wrangler secret put BETTER_AUTH_SECRET        # openssl rand -base64 32
wrangler secret put VAPID_PUBLIC_KEY
wrangler secret put VAPID_PRIVATE_KEY
wrangler secret put TURN_KEY_ID
wrangler secret put TURN_API_TOKEN
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put TURNSTILE_SECRET
wrangler secret put SENTRY_DSN
```
Repeat with `--env staging` / `--env production`. Locally these go in `.dev.vars` (gitignored).

## 4. First-time setup runbook
```bash
corepack enable && pnpm i
pnpm add hono better-auth drizzle-orm zod @tanstack/react-query zustand react-router dexie aws4fetch
pnpm add -D wrangler drizzle-kit vite @cloudflare/vitest-pool-workers vitest \
            @cloudflare/workers-types playwright vite-plugin-pwa tailwindcss typescript eslint prettier

wrangler login
wrangler d1 create ripple-local && wrangler d1 create ripple-staging && wrangler d1 create ripple-prod
wrangler r2 bucket create ripple-media-local   # + staging, prod
wrangler kv namespace create KV
wrangler queues create push-queue && wrangler queues create push-dlq

# schema
pnpm drizzle-kit generate
wrangler d1 migrations apply ripple-local --local

# R2 S3 credentials for presigning: dash → R2 → Manage API tokens → Object Read & Write
# TURN: dash → Realtime → TURN → create key → TURN_KEY_ID / TURN_API_TOKEN
npx web-push generate-vapid-keys

# email: verify the sending domain in dash → Email → Email Sending; add SPF/DKIM/DMARC records
pnpm dev            # vite (5173) + wrangler dev (8787) concurrently, Vite proxies /api → 8787
```

## 5. Deploy
```bash
wrangler d1 migrations apply ripple-prod --remote     # always before the code deploy
pnpm build                                            # vite build → dist/client
wrangler deploy --env production
```
CI does this on `main`. **Migration ordering rule:** schema changes must be backward-compatible with the currently deployed Worker (expand → deploy → contract in a later release), because migrations and code do not deploy atomically.

Gradual rollout for risky releases:
```bash
wrangler versions upload --env production
wrangler versions deploy <new>@10% <old>@90% --env production
```
DO caveat: a gradual rollout runs two code versions against the same Durable Objects. Keep DO RPC and WS protocol changes additive, and version the WS protocol (`{v:1}` in `hello`) so an old client never trips over a new frame type.

## 6. Email (Cloudflare Email Sending)
- Verify the sending domain in the dashboard; add the SPF, DKIM, and DMARC (`p=quarantine; rua=…`) records it gives you.
- Templates: `verify-email`, `reset-password`, `invite`, `friend-request-digest` — plain-text alternative for every one (invites land in spam without it).
- Better Auth's `sendVerificationEmail` / `sendResetPassword` hooks call the `EMAIL` binding directly; no third-party key.

## 7. Release process
1. Squash-merge to `main` → CI deploys staging.
2. Smoke staging with the release checklist in 09.
3. Tag `vX.Y.Z`; promote to production via `workflow_dispatch`.
4. Watch 30 min: Sentry new issues, connect-success metric, push failure rate, Worker 5xx.
5. **Rollback:** `wrangler rollback --env production` (instant, code only). D1 rolls back only by forward-fix migration — rehearse this on staging before launch. DO storage never rolls back; that is why DO schema changes are additive-only.

## 8. Cost model (~1 000 MAU, 1:1 calls)
| Item | Estimate |
|---|---|
| Workers Paid (incl. requests + CPU) | $5/mo base |
| Durable Objects | ~$5–15/mo (hibernation makes idle sockets ~free; billed on requests + active duration + SQLite storage) |
| D1 | ~$0–5/mo (5 GB storage, 25 B reads free tier is generous for this shape) |
| R2 | $0.015/GB-mo, **zero egress** — ~$1–5/mo |
| Queues | ~$0.40/M ops — <$1/mo |
| Realtime TURN | ~$0.05/GB relayed; ~20% of calls relay → $5–15/mo |
| Email Sending | included/low |
| Sentry | $0–26/mo |
| **Total** | **~$15–70/mo** |
Cheaper than the equivalent managed-backend design mainly because of R2's zero egress and DO hibernation. The tradeoff is paid in engineering: authorization, realtime lifecycle, and auth flows are code you own and must test.

## 9. Ops runbook
| Symptom | First checks |
|---|---|
| Calls fail to connect | `/api/turn` 5xx? TURN token valid? relay share spike in Analytics Engine? `calls.end_reason='ice-failed'` rate |
| No push | VAPID mismatch after a secret rotation? `push-dlq` depth? 410s piling in `push_subscriptions`? Queue consumer erroring in Workers Logs |
| Messages delayed / missing | DO CPU or storage limits per conversation; WS drops without gap-fill (check `hello` backfill sizes); Smart Placement moved the Worker away from D1 |
| Conversation list stale | preview alarm failing in ConversationDO → check alarm errors in logs; run the 3am reconcile cron manually |
| Upload 403 | presigned URL clock skew or expiry; R2 token rotated without redeploy |
| Signup mail missing | Email Sending domain status; DMARC drift; recipient domain blocking |
| DO "storage limit" errors | a conversation exceeded per-object SQLite limits → archive old messages to R2 (retention job) |
| High D1 latency | too many per-request queries (N+1 in the conversation list); batch with `db.batch()` |
