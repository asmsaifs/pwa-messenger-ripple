# 09 — Build Roadmap (15 milestones)

Each milestone = one PR, one agent session, independently verifiable. Do not start N+1 before N's exit criteria pass.

| # | Milestone | Deliverables | Exit criteria |
|---|---|---|---|
| **M0** | Repo & toolchain | Vite+TS+Tailwind+shadcn, Hono Worker, `wrangler.jsonc`, Workers Static Assets serving the SPA, vitest-pool-workers wired, ESLint layering rules, CI skeleton, `docs/` + CLAUDE.md | `pnpm typecheck lint test build` green; `wrangler dev` serves the SPA and `/api/health` |
| **M1** | D1 schema + repos | Drizzle schema, migrations 0001, seed script, `repos/*` with `actor` first-arg convention, the no-drizzle-outside-repos lint rule | `wrangler d1 migrations apply --local` clean; repo unit tests pass |
| **M2** | **Policy layer** | `src/server/policy/` implementing the full matrix in docs/02 §5, `Actor` middleware, CSRF middleware, error taxonomy, route-policy CI guard | every policy function has an allow **and** deny test; the guard fails a route with no policy import |
| **M3** | Auth | Better Auth + D1 adapter + KV secondary storage, signup/login/verify/reset, Turnstile on signup, session cookie config, route guards, profile bootstrap | E2E #1 passes; session survives reload; unverified user is blocked from invite/message/call |
| **M4** | App shell + PWA | router, layouts, manifest, SW precache, install prompt, offline shell, icons, API client with typed `src/shared` schemas | Lighthouse PWA installable; offline load works |
| **M5** | Friends & invites | friends UI, invite/claim routes, Email Sending templates, accept/decline/block, RateLimiterDO | E2E #2, #3, #10 pass; 11th invite in a day returns `rate/limited` |
| **M6** | **ConversationDO + text chat** | DO with SQLite messages, WS hibernation protocol, `hello`/backfill, send/receipt/typing, D1 preview alarm, conversation list, virtualized thread | E2E #4, #13; DO tests cover gapless seq, dedupe, debounced preview write |
| **M7** | UserDO + presence | personal socket, incoming events, unread counts, badging, presence | unread badge accurate across two tabs; socket reconnects with backoff |
| **M8** | Offline outbox | Dexie mirror, outbox state machine, Background Sync, retry UI, `clientId` dedupe end-to-end | E2E #9; 3 concurrent flushes produce exactly one message |
| **M9** | Attachments: files | presign/complete flow, magic-byte sniffing, quota, R2 lifecycle, download + Dexie blob cache, orphan cron | E2E #5; a `.png` that is actually HTML is rejected at `/complete` |
| **M10** | Attachments: camera photo | in-app capture sheet, WebP compression, `<input capture>` fallback | photo round-trips; denied-permission fallback works |
| **M11** | Voice messages | MediaRecorder, live waveform, cancel/preview/send, player with scrub and stored waveform | E2E #6; mic indicator off immediately after recording |
| **M12** | Push notifications | SW push/notificationclick, subscribe UX, `push-queue` producer + consumer, VAPID via WebCrypto, DLQ, `pushsubscriptionchange` | notification for message + friend request on a real Chromebook; 410 endpoints self-clean |
| **M13** | **Voice calls** | `/api/turn`, CallDO signaling + state machine + ring alarm, perfect-negotiation reducer, call UI, minimized bar, wake lock, device picker, call_event messages, Analytics Engine metrics | E2E #7, #8, #11; connect success ≥ 97% over 50 scripted runs |
| **M14** | Call push & ring | high-urgency push with Accept/Decline actions, ringtone, call-cancelled push to close the notification, busy handling | E2E #12; call answered from a backgrounded tab |
| **M15** | Settings, privacy, hardening, launch | profile/devices/storage/blocked list, export + delete account (**including DO storage purge**), a11y pass, dark mode, all rate limits, Sentry, metrics dashboard, security checklist (05 §11), staging soak, prod deploy | full checklist signed off |

## Sequencing notes
- **M2 before M3.** Building auth first tempts you to sprinkle checks into routes; building the policy layer first makes the shape obvious. This ordering is the main defense against the RLS-shaped hole in this stack.
- **M13 is the risk concentration.** Spike it on a throwaway branch right after M3: two hardcoded users, a bare CallDO, no UI — just prove TURN credential minting, Chromebook audio, and relay fallback before M5–M12 are built on assumptions.
- **M6 is the second risk.** The WS lifecycle (reconnect, gap-fill, hibernation, membership cache) is where a managed realtime service would have carried you. Budget real time for it.

## Release checklist (before each prod promote)
- [ ] CI green including the nightly TURN relay test
- [ ] `wrangler d1 migrations apply --remote` run **before** the code deploy; change is backward-compatible with the currently deployed Worker
- [ ] DO protocol changes are additive; WS `hello` version bumped if the frame set changed
- [ ] Manual on a real Chromebook: call in/out, mic indicator off after, headset swap mid-call, lid close during call
- [ ] Push tested from a cold-started installed PWA
- [ ] Offline: airplane mode → send 3 → reconnect → exactly 3 delivered, in order
- [ ] Security checklist 05 §11 all boxes
- [ ] Rollback rehearsed (`wrangler rollback` + a forward-fix migration)
- [ ] Version tagged, changelog written, Sentry release with sourcemaps uploaded
