# 05 — Security & Privacy (Cloudflare stack)

## 1. Principles
1. **Authorization is application code.** D1 has no RLS. `src/server/policy/` is the only line of defense; there is no database backstop. Every policy function is unit-tested for allow *and* deny (07 §2). Treat a missing check as a Sev-1.
2. **The browser never speaks to the database.** Only `/api/*`. Nothing is exposed unless a route exposes it.
3. **Server is authoritative** for call state (CallDO), message ordering (ConversationDO), rate limits (RateLimiterDO), and quotas.
4. **Identity comes from the session cookie or the socket attachment — never from a request body field.**
5. **Least privilege bindings.** The Worker holds every credential; the client bundle holds only the VAPID *public* key and the Sentry DSN.

## 2. Authentication (Better Auth)
- Email + password, min 10 chars, `zxcvbn` score ≥ 2, breach check via k-anonymity range query to HIBP (optional, cached in KV).
- `requireEmailVerification: true` — unverified accounts cannot invite, message, or call.
- Session cookie `__Host-ripple.session`: `HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain` attribute. 30-day expiry, rolling refresh at 1 day. Same-origin deployment (SPA + API on one Worker) means no cross-site cookie problems and no token in JS — **an XSS cannot exfiltrate the session token**, unlike a localStorage JWT.
- Password reset: single-use token, 1 h TTL, and **resetting revokes all sessions** (`DELETE FROM session WHERE userId = ?` + KV purge).
- Password change requires the current password. Email change requires re-verification of both addresses.

## 3. CSRF
`SameSite=Lax` blocks cross-site POSTs from forms but not all vectors. Enforced middleware on every unsafe method (`POST/PUT/PATCH/DELETE`) and every WebSocket upgrade:
```ts
const origin = c.req.header('Origin') ?? c.req.header('Sec-Fetch-Site');
if (!isAllowedOrigin(origin)) throw new AppError('auth/csrf', 403);
```
Allowlist: exact production origin, staging origin, `http://localhost:5173` in dev only. `Sec-Fetch-Site: same-origin` is accepted as an equivalent signal. WebSocket upgrades **must** be origin-checked — browsers do not apply CORS to them.

## 4. Content Security Policy
Set in the Worker response for HTML, and in `public/_headers` for assets:
```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' blob: data: https://<account>.r2.cloudflarestorage.com;
  media-src 'self' blob: https://<account>.r2.cloudflarestorage.com;
  connect-src 'self' wss://<origin> https://<account>.r2.cloudflarestorage.com https://*.ingest.sentry.io;
  font-src 'self'; worker-src 'self';
  frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self';
  upgrade-insecure-requests
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: microphone=(self), camera=(self), geolocation=(), payment=(), usb=()
Cross-Origin-Opener-Policy: same-origin
```
No `'unsafe-eval'`. Presigned R2 URLs live on the R2 S3 endpoint — keep that host in `img-src`/`media-src`/`connect-src`, or front R2 with a Worker route on the same origin and drop the exception entirely (preferred once egress patterns are known).

## 5. Durable Object trust boundary
- DO namespaces have **no public route**. They are reachable only from bound Workers. That is the perimeter — but it is not authorization.
- The Worker authenticates first, then attaches the verified identity: `ws.serializeAttachment({ userId, deviceId })`. On every frame the DO reads the attachment, never the frame body, for identity.
- The DO **re-verifies membership** on connect and re-validates on a 60 s cache TTL, and immediately on a `membershipChanged` RPC. A user blocked mid-conversation loses write access within one RPC, not within a cache TTL.
- DO RPC methods are the internal API; none of them accept an "acting as" parameter that the caller could forge from a client-controlled value.

## 6. WebRTC-specific
- **IP leakage**: `RTCPeerConnection` exposes local/public IPs to the peer. Document it; Settings toggle "Hide my IP (relay all calls)" → `iceTransportPolicy:'relay'` (costs TURN bandwidth).
- **TURN credentials**: minted server-side only, time-limited (1 h), per-user rate limited (60/h). `TURN_API_TOKEN` lives in Worker secrets and never reaches the client.
- **Signaling authorization**, three independent layers: the `callId` is an unguessable UUID; the WS upgrade runs a policy check that the actor is the caller or callee; the CallDO stamps `from` on every relayed frame and clients reject unexpected senders.
- **Media encryption**: DTLS-SRTP always. **Not end-to-end vs. the service** — CallDO relays SDP and could swap DTLS fingerprints. UI copy must read "Encrypted in transit", never "End-to-end encrypted". v2: SFrame via `RTCRtpScriptTransform` with a friendship-scoped key.
- Cap one `RTCPeerConnection`; always `pc.close()` and `track.stop()` on every exit path — a leaked track leaves the Chrome OS mic indicator lit, which users correctly read as spying.

## 7. Files & R2
- Bucket private. No `r2.dev` public URL, no public custom domain.
- Presigned PUT is scoped to one exact key, method, and content-length; 15 min TTL. Presigned GET 1 h.
- **Never trust the client's `Content-Type`.** On `/complete`, HEAD the object, compare byte size exactly, sniff magic bytes, and enforce an allowlist. SVG rejected outright. Mismatch ⇒ delete the object, mark `failed`.
- Downloads served with `Content-Disposition: attachment` except images and audio, which get a server-determined `Content-Type`.
- Quota: 2 GiB/user, enforced against `profiles.storage_used` at sign time and corrected at complete time.
- Path traversal: keys are constructed server-side from validated UUIDs only — client-supplied filenames are stored in a metadata column and never used in a key.

## 8. Abuse controls (RateLimiterDO unless noted)
| Vector | Control |
|---|---|
| Invite spam | 10/day/user; 1 resend/24 h/invitation; unverified users blocked entirely |
| Message flood | 30/10 s per conversation, 300/hour per user |
| Call spam | 1 outgoing ringing call at a time; 20/hour/user; blocked users cannot ring |
| Signup abuse | Turnstile on signup + per-IP KV limit (5/h); disposable-domain blocklist |
| Login brute force | 10/10 min per email **and** per IP; exponential lockout |
| Enumeration | invite + profile endpoints return identical shapes/404s regardless of existence |
| Storage abuse | 2 GiB quota + 24 h orphan sweep |
| WS abuse | max 1 UserDO socket per device (5 devices/user), 100 frames/10 s per socket, drop on breach |
| Harassment | block (mutual invisibility) + report → `reports` + ops alert |

## 9. Privacy / data lifecycle
- Retention: messages until deleted; attachments 1 year; call records 1 year; exports 7 days; Workers Logs 7 days; Analytics Engine 90 days (no PII — user ids hashed with a rotating salt).
- Export: `/api/account/export` → Queue job → NDJSON of profile, friends, all conversation messages (read from each ConversationDO), call log, plus signed media links → zip in R2 → push when ready.
- Deletion: sessions revoked and profile anonymized immediately; hard purge at +30 days by cron — D1 rows, R2 objects, **and each ConversationDO's storage** (`deleteAll()` on the DO, which is easy to forget: message bodies do not live in D1).
- Analytics: no third-party trackers; Analytics Engine only, no cookies ⇒ no cookie banner.
- Sub-processors to list: Cloudflare (compute, storage, email, TURN), Sentry, Google (Web Push endpoint for Chrome).

## 10. Secrets inventory (`wrangler secret put`)
| Secret | Purpose | Rotation |
|---|---|---|
| `BETTER_AUTH_SECRET` | session signing | on incident (invalidates sessions) |
| `TURN_KEY_ID` / `TURN_API_TOKEN` | Realtime TURN cred minting | quarterly |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push | never (breaks subs); 2-key rollover if forced |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | presigning (S3 API) | quarterly |
| `TURNSTILE_SECRET` | signup bot check | quarterly |
| `SENTRY_DSN` | error reporting | — |
Client-side (public by nature, `VITE_*`): `VITE_VAPID_PUBLIC_KEY`, `VITE_SENTRY_DSN`, `VITE_TURNSTILE_SITE_KEY`, `VITE_APP_ENV`.
`gitleaks` in pre-commit and CI. `.dev.vars` gitignored; `.dev.vars.example` committed.

## 11. Pre-launch security checklist
- [ ] Every route has an explicit policy call — verified by a coverage script that lists routes with no `policy/` import
- [ ] Two-account test with raw `curl` and a stolen conversation id: A cannot read, write, or upload into B's conversation
- [ ] Blocked user: cannot message, call, see presence, or read the profile; existing conversation returns `policy/blocked`
- [ ] WebSocket upgrade rejected without a session cookie and with a foreign `Origin`
- [ ] DO frame with a forged `userId` field in the body is ignored (identity comes from the attachment)
- [ ] `grep -r` over `dist/` finds no `R2_SECRET`, `TURN_API_TOKEN`, `VAPID_PRIVATE`, `BETTER_AUTH_SECRET`
- [ ] Presigned PUT cannot be replayed for a different key or after expiry; oversize body rejected
- [ ] Uploading a `.png` that is actually an HTML file is rejected at `/complete`
- [ ] CSP verified with zero console violations on every route
- [ ] Invite token single-use, expired token rejected, token never appears in logs or Sentry breadcrumbs
- [ ] Account deletion purges ConversationDO storage, not just D1
- [ ] Mic/cam tracks stopped after every call end path — verified on a real Chromebook
- [ ] Rate limits verified by `scripts/abuse-test.ts`; `npm audit --production` clean; Dependabot on
