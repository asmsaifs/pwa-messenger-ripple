# 01 — Architecture (Cloudflare stack)

## 1. Stack decision

| Layer | Choice | Why | Swap cost |
|-------|--------|-----|-----------|
| UI | React 19 + TypeScript 5.7 + Vite 6 | Fast HMR, best PWA plugin ecosystem | — |
| Styling | Tailwind CSS 4 + shadcn/ui (Radix) | Accessible primitives | low |
| State | Zustand (client) + TanStack Query (server cache) | Small; Query handles retry/offline | low |
| Routing | React Router 7 (data router) | Nested layouts, lazy routes | low |
| PWA | `vite-plugin-pwa` (Workbox 7, injectManifest) | custom SW for Push | — |
| Hosting | **Cloudflare Workers + Static Assets** | SPA and API on one origin ⇒ no CORS, cookies work | — |
| API | **Hono** on Workers | tiny, typed, Workers-native routing | low |
| Auth | **Better Auth** (email+password) + D1 adapter | httpOnly cookie sessions, verification/reset built in | med |
| DB | **Cloudflare D1** (SQLite) + Drizzle ORM | relational, cheap, migrations, typed | high |
| Realtime | **Durable Objects** + WebSocket Hibernation | chat fanout, presence, typing, WebRTC signaling | high |
| Message store | **DO SQLite** (per conversation) | single-writer ordering, colocated with the socket | high |
| Blobs | **R2** (S3 API, presigned URLs) | cheap, zero egress fees | low |
| Async work | **Queues** (push fanout) + **Cron Triggers** (sweeps) | retries + DLQ for free | low |
| Cache | **Workers KV** | session lookup cache, ICE config | low |
| Email | **Cloudflare Email Service** (Email Sending binding) | same vendor, no extra key | low |
| Media | WebRTC P2P (`RTCPeerConnection`), Opus | 1:1 only ⇒ no SFU cost | — |
| TURN | **Cloudflare Realtime TURN** | UDP+TCP+TLS/443, global | low |
| Push | Web Push (VAPID) from a Worker via WebCrypto | no FCM SDK; works on Chrome OS | low |
| Metrics | **Workers Analytics Engine** (call quality) + Workers Logs | no extra service for time-series | low |
| Errors | Sentry (browser + Workers) | — | low |

### What changed vs. a Supabase design — read this first
1. **There is no Row Level Security.** D1 is SQLite; it has no RLS, no `auth.uid()`, no policies. **All authorization is application code in the Worker.** This is the single biggest risk of this stack. It is contained by the repository pattern in §5 — treat that section as mandatory, not stylistic.
2. **No auto-generated data API.** The browser never talks to the database. It talks to *your* REST endpoints, which is stricter by default (nothing is exposed unless you write it).
3. **Realtime is code you own.** Durable Objects give ordering and fanout, but subscription lifecycle, gap-fill, and backfill are yours to implement (see §4.1).
4. **Sessions are httpOnly cookies, not localStorage JWTs.** Strictly better against XSS token theft; costs a CSRF defense (SameSite=Lax + origin check).
5. **Two databases.** D1 = users, friendships, conversations, metadata. DO SQLite = message bodies. See §3 for the split rule and the one denormalization that crosses it.

## 2. System diagram

```
┌──────────────── Chromebook / Chrome ─────────────────┐
│  PWA                                                  │
│  ├─ React app shell        ├─ Service Worker (push)   │
│  ├─ IndexedDB (Dexie: cache, outbox, blobs)           │
│  └─ WebRTC engine (RTCPeerConnection, MediaRecorder)  │
└─┬──────────┬──────────────┬───────────────────────────┘
  │ HTTPS    │ WSS          │ SRTP/DTLS
  │ (cookie) │              │
  ▼          ▼              ▼
┌─────────────────────────────────────┐   ┌────────────────┐
│ Worker  (ripple.app — one origin)   │   │  Peer browser  │
│  ├ Static Assets (SPA)              │   └──────┬─────────┘
│  ├ Hono API /api/*                  │          │ relay if NAT blocked
│  ├ Better Auth /api/auth/*          │          ▼
│  └ WS upgrade → routes to a DO      │   ┌────────────────┐
└──┬────────┬─────────┬────────┬──────┘   │ Cloudflare TURN│
   │        │         │        │          └────────────────┘
   ▼        ▼         ▼        ▼
 ┌────┐ ┌──────┐ ┌──────────────────────────┐ ┌────────┐
 │ D1 │ │  R2  │ │ Durable Objects          │ │ Queues │→ Web Push
 └────┘ └──────┘ │  ConversationDO (msgs)   │ └────────┘  (VAPID)
   ▲             │  UserDO (personal bus)   │      ▲
   │             │  CallDO (signaling)      │      │
 ┌────┐          │  RateLimiterDO           │  ┌────────┐
 │ KV │          └──────────────────────────┘  │  Cron  │
 └────┘                                        └────────┘
                        Email Sending binding → invites, auth mail
```

## 3. Data placement rule

| Data | Home | Reason |
|---|---|---|
| users, sessions, friendships, invitations | D1 | queried across entities, joins, uniqueness constraints |
| conversations, members, `last_message_preview` | D1 | powers the conversation list in one query |
| **message rows** | ConversationDO SQLite | single writer ⇒ gapless `seq`, colocated with the WebSocket |
| receipts, typing, presence | ConversationDO (receipts persisted, typing ephemeral) | high write rate, worthless outside the conversation |
| attachment metadata | D1 + object in R2 | needs cross-conversation quota queries |
| call records | D1 (record) + CallDO (live state) | history query vs. live signaling |
| push subscriptions | D1 | fanout reads them by user |
| rate counters | RateLimiterDO | durable, atomic, no D1 write amplification |
| call quality samples | Analytics Engine | time-series, never joined |

**The one crossing:** after each message write, `ConversationDO` debounces (alarm, 1 s) and writes `{last_message_at, preview, sender_id}` to D1's `conversations` row. D1 is a *derived* index for the list view. If the two disagree, the DO wins — a `repair-conversation-previews` cron reconciles nightly.

## 4. Runtime flows

### 4.1 Message send (optimistic + offline-safe)
1. Composer writes to Dexie `outbox` with `client_id` (UUIDv7); UI renders immediately as ⏳.
2. Send over the open conversation WebSocket: `{t:'send', clientId, body, kind}`. If the socket is down, POST `/api/conversations/:id/messages` instead (same handler path server-side).
3. `ConversationDO` validates membership, inserts with `UNIQUE(client_id)` (retries are idempotent — the duplicate insert returns the existing row), assigns `seq = max(seq)+1`, broadcasts to all sockets, enqueues push for offline members, schedules the D1 preview alarm.
4. Sender reconciles by `clientId` → status `sent`. Offline → SW Background Sync tag `outbox-flush`.
5. **Gap-fill on reconnect:** client sends `{t:'hello', lastSeq}`; DO replies with every message where `seq > lastSeq` (capped at 500, else the client refetches a page). This is what replaces "the realtime service just handles it" — it must exist or messages are silently lost on socket drops.

### 4.2 Attachment send
1. Client compresses (images → WebP ≤1600px q0.8; audio stays Opus).
2. `POST /api/attachments/sign` → Worker checks membership + quota + declared size, inserts an `attachments` row `status='pending'`, returns a **presigned R2 PUT URL** (15 min).
3. Client PUTs directly to R2 with progress.
4. `POST /api/attachments/:id/complete` → Worker HEADs the object, verifies size and sniffs the magic bytes against the declared MIME, sets `status='ready'`, then the message is sent referencing it.
5. Receiver gets a presigned GET (1 h) from `GET /api/attachments/:id/url`.
   Orphan sweep cron deletes `pending` rows older than 24 h and their objects.

### 4.3 Call establishment
```
Caller                          CallDO (ws)                        Callee
  │ POST /api/calls {calleeId} ────────────────────────────────────►│
  │   → D1 calls row 'ringing', CallDO created, ring alarm t+45s     │
  │   → Queue push (urgency high) ─────────────────────────────────►│ SW notification
  │ WS connect call/:id ; getUserMedia ; createOffer                 │
  │ {t:'offer', sdp} ──────────────► relay ────────────────────────►│ WS connect, accept
  │◄──────────────────────────────── relay ◄──── {t:'answer', sdp}   │
  │◄────────── trickle ICE both ways (relayed by CallDO) ───────────►│
  │ ontrack → <audio>            connectionState 'connected'         │
  │ {t:'bye'} ────► CallDO writes D1 status/duration, closes sockets │
```
- CallDO owns the state machine and is the *only* writer of `calls.status` ⇒ no race between the two clients.
- Ring timeout is a DO **alarm** at +45 s → `missed` + push cancel. (No cron sweep needed; the alarm is exact.)
- ICE servers from `GET /api/turn` — HMAC creds minted server-side, 1 h TTL, cached client-side for `ttl-300`s.
- Perfect negotiation: caller `polite=false`, callee `polite=true`.
- Reconnect: on `iceconnectionstate === 'disconnected'` → `restartIce()` ×3 over 15 s → else `failed`.

### 4.4 Invite by email
1. `POST /api/friends/invite {email}` → RateLimiterDO checks 10/day.
2. Email normalized (trim+lowercase). If a user exists → create `friendships` row `pending` + push. Else create `invitations` row storing **only** `sha256(token)` and send mail via the Email Sending binding with `/invite/{token}`.
3. Signup with a token in the session → `claimInvitation()` in a D1 batch: mark claimed, create friendship, create conversation + members.
4. 14-day expiry, single use.

## 5. Authorization architecture (replaces RLS — mandatory)

```
src/server/
├─ index.ts            # Hono app, mounts routes
├─ middleware/
│  ├─ auth.ts          # loads session → c.set('actor', Actor) ; 401 if absent
│  ├─ csrf.ts          # Origin/Sec-Fetch-Site check on all unsafe methods
│  └─ ratelimit.ts     # RateLimiterDO wrapper
├─ policy/
│  └─ index.ts         # THE authorization module. Pure functions, unit-tested.
├─ repos/              # THE ONLY place that may touch `env.DB` / drizzle
│  ├─ friends.ts  conversations.ts  attachments.ts  calls.ts  push.ts
└─ routes/             # thin: parse → policy check → repo call → serialize
```

Three enforced rules (ESLint `no-restricted-imports` + a custom rule, and a CI grep):
1. **No route or DO may import `drizzle` or touch `env.DB`.** Only `repos/*`.
2. **Every exported repo function takes `actor: Actor` as its first parameter** and re-checks authorization itself — not merely trusting the route. Defense in depth, because the route layer is where an agent will forget a check.
3. **Every `policy/*` function has a unit test asserting both allow and deny**, including the blocked-friend case.

```ts
// policy/index.ts — shape
export type Actor = { userId: string; sessionId: string };
export async function assertConversationMember(env: Env, actor: Actor, conversationId: string): Promise<Membership>;
export async function assertFriends(env: Env, actor: Actor, otherId: string): Promise<void>;   // throws on blocked
export async function assertNotBlocked(env: Env, a: string, b: string): Promise<void>;
export async function assertAttachmentReadable(env: Env, actor: Actor, attachmentId: string): Promise<Attachment>;
```

**Durable Object trust boundary:** DO namespaces are not reachable from the internet — only from bound Workers. The Worker authenticates the user, then calls the DO by RPC or upgrades the WebSocket with the verified `userId` attached (`ws.serializeAttachment({userId, conversationId})`, which survives hibernation). **The DO still re-verifies membership** on connect and on every write, via an RPC back to a repo helper, cached in DO memory for the connection's lifetime and invalidated on `membership-changed` broadcast. Never accept a `userId` from a client-supplied field.

## 6. Durable Object inventory

| Class | `idFromName` | Storage | Responsibilities |
|---|---|---|---|
| `ConversationDO` | `conversationId` | SQLite: `messages`, `receipts`, `members_cache` | append + broadcast messages, typing, presence, receipts, gap-fill, push fanout enqueue, D1 preview alarm |
| `UserDO` | `userId` | KV storage: presence, unread counts | personal event bus (incoming call, friend request, badge), one socket per device |
| `CallDO` | `callId` | KV storage: call state | SDP/ICE relay, call state machine, ring-timeout alarm, writes final `calls` row |
| `RateLimiterDO` | `${userId}:${action}` | SQLite counters | atomic durable quotas (invites/day, msgs/10s, calls/hour) |

Sockets per client: **at most 2** — `UserDO` (always) + `ConversationDO` (open thread) — plus a third, short-lived, to `CallDO` during a call.

## 7. Repo layout

```
pwa_voice_chat/
├─ docs/
├─ public/            # icons, sounds, manifest
├─ src/
│  ├─ client/         # React app (features/, components/, hooks/, lib/)
│  │  ├─ features/    # auth friends chat attachments call notifications settings
│  │  └─ lib/         # api client, db (dexie), webrtc, media, utils
│  ├─ server/         # Worker: index.ts, routes/, repos/, policy/, middleware/, email/, push/
│  ├─ durable/        # ConversationDO.ts UserDO.ts CallDO.ts RateLimiterDO.ts
│  ├─ shared/         # types + zod schemas shared by client and server (THE contract)
│  └─ sw.ts           # service worker
├─ migrations/        # D1 SQL, forward-only (drizzle-kit generated)
├─ e2e/               # Playwright
├─ wrangler.jsonc
└─ .github/workflows/
```
`src/shared/` is what makes this stack pleasant: one zod schema per endpoint, imported by the Hono route (validation) and the client (types + parsing). Never define a request shape twice.

## 8. Security posture summary (detail in 05)
- Sessions: httpOnly, Secure, SameSite=Lax cookies; CSRF via origin check on unsafe methods.
- Authorization: Worker-side only — see §5. There is no database backstop, so the policy tests in 07 are load-bearing.
- R2 objects private; access only via short-lived presigned URLs after a policy check.
- Media DTLS-SRTP encrypted in transit. **Not** end-to-end vs. the service (we relay SDP). UI must say "Encrypted in transit".
