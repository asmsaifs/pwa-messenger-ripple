# 03 — API Contracts (Hono on Workers + Durable Object protocols)

Three surfaces: (1) REST under `/api/*`, (2) WebSocket protocols to three DO classes, (3) internal DO RPC. Every request/response shape is a zod schema in `src/shared/schemas/` imported by both sides — never typed twice.

Envelope: success `200 { data }`; failure `4xx/5xx { error: { code, message, details? } }` with `code` from 05 §5 taxonomy. Auth by httpOnly cookie; all unsafe methods require an `Origin` match (see 05 §3).

## 1. REST

### Auth (Better Auth, mounted at `/api/auth/*`)
`POST /sign-up/email` · `POST /sign-in/email` · `POST /sign-out` · `POST /verify-email` · `POST /forget-password` · `POST /reset-password` · `GET /get-session`.
Config: email+password only, `requireEmailVerification: true`, session 30 d with 1 d refresh, cookie `__Host-ripple.session` (`Secure; HttpOnly; SameSite=Lax; Path=/`), KV secondary storage. Signup accepts `?invite=<token>` — stored on the session and claimed after verification.

### Profile
```
GET    /api/me                     → { user, profile, unreadTotal }
PATCH  /api/me                     { displayName?, statusText? }
POST   /api/me/avatar/sign         { contentType, size } → { uploadUrl, key }
POST   /api/me/avatar/complete     { key } → { avatarUrl }
GET    /api/users/:id              → public profile (404 unless friend)
```

### Friends
```
GET    /api/friends                → { friends[], incoming[], outgoing[], invitations[] }
POST   /api/friends/invite         { email } → { kind: 'request_sent'|'email_sent' } | 429 rate/limited
POST   /api/friends/:id/accept     → { conversationId }
POST   /api/friends/:id/decline
POST   /api/friends/:id/block      /unblock
DELETE /api/friends/:id
GET    /api/invites/:token         → { inviterName } (unauthenticated preview) | 410 expired
POST   /api/invites/:token/claim   → { friendshipId, conversationId }
POST   /api/invites/:id/resend     → 429 if within 24 h
DELETE /api/invites/:id
```
`invite` returns an identical response shape whether or not the email is registered when `PRIVACY_STRICT_INVITES=true`; default returns the distinguishing `kind` (the inviter learns nothing they couldn't learn by waiting).

### Conversations & messages
```
GET  /api/conversations                          → list (D1 only, one query)
GET  /api/conversations/:id                      → { conversation, peer, membership }
GET  /api/conversations/:id/messages?before=<seq>&limit=50   → proxied to ConversationDO
POST /api/conversations/:id/messages             { clientId, kind, body?, attachmentId? }
                                                 → { message }  (HTTP fallback for the WS path)
POST /api/conversations/:id/read                 { seq }
POST /api/conversations/:id/mute                 { until|null }
DELETE /api/messages/:conversationId/:seq        → tombstone (sender only)
```

### Attachments
```
POST /api/attachments/sign      { conversationId, contentType, size, name, kind }
                                → { attachmentId, uploadUrl, key, expiresAt }
POST /api/attachments/:id/complete { width?, height?, durationMs?, waveform? }
                                → { attachment }     # server HEADs R2, sniffs magic bytes
GET  /api/attachments/:id/url   → { url, expiresAt } # presigned GET, 1 h
```
Server-side validation on complete: object exists, `size` matches the HEAD within 0 bytes, sniffed MIME ∈ allowlist and consistent with the declared type, else object deleted and row `failed`.

### Calls
```
POST /api/calls                 { conversationId } → { callId, wsUrl, iceServers }
POST /api/calls/:id/decline     → 204
GET  /api/calls?conversationId= → history page
GET  /api/turn                  → { iceServers, ttlSeconds }
```
`GET /api/turn` mints Cloudflare Realtime TURN credentials server-side (1 h), caches per user in KV for `ttl-300`s, rate limited 60/h.

### Push & account
```
POST   /api/push/subscribe      { endpoint, keys:{p256dh,auth} } → 204
DELETE /api/push/subscribe      { endpoint } → 204
POST   /api/push/test           → 204
POST   /api/account/export      → { jobId }  → Queue → { downloadUrl } via push when ready
DELETE /api/account             { password } → 202 (purge scheduled +30 d)
POST   /api/reports             { targetId, conversationId?, seq?, reason }
```

## 2. WebSocket protocols

All three use `WebSocketPair` + **Hibernation API** (`ctx.acceptWebSocket`) so idle sockets cost nothing. The verified identity is stored with `ws.serializeAttachment({ userId, deviceId })` — it survives hibernation and is the **only** trusted source of the sender's identity. A `userId` field in an inbound frame is ignored.

Upgrade path: `GET /api/ws/conversation/:id` → Worker authenticates the cookie, runs `assertConversationMember`, then forwards the upgrade to `env.CONVERSATION.getByName(conversationId)`.

### 2.1 `ConversationDO` — `/api/ws/conversation/:id`
Client → server:
```ts
| { t:'hello';  lastSeq:number }
| { t:'send';   clientId:string; kind:'text'|'file'|'image'|'voice'; body?:string; attachmentId?:string; replyToSeq?:number }
| { t:'read';   seq:number }
| { t:'typing'; on:boolean }
| { t:'react';  seq:number; emoji:string }                // toggle: add if the caller hasn't reacted with this emoji on this seq, else remove
| { t:'ping' }
```
Server → client:
```ts
| { t:'ready';   lastSeq:number; members:{userId:string;presence:string}[] }
| { t:'backfill';messages:Message[]; hasMore:boolean; reactions:{seq:number;userId:string;emoji:string}[] }   // reply to hello, seq > lastSeq, cap 500; reactions cover only the returned messages
| { t:'message'; message:Message }                        // includes echo to sender w/ clientId
| { t:'receipt'; userId:string; deliveredSeq:number; readSeq:number }
| { t:'typing';  userId:string; on:boolean }
| { t:'reaction';seq:number; userId:string; emoji:string; on:boolean }   // broadcast to all sockets incl. the toggling user, `on` is the resulting state
| { t:'presence';userId:string; presence:'online'|'away'|'offline' }
| { t:'error';   code:string; message:string; clientId?:string }
| { t:'pong' }
```
Rules:
- `send` is idempotent on `clientId`; a duplicate returns the original `message` frame, never a second row.
- The DO checks `members_cache`; on miss or stale (>60 s) it RPCs the Worker's membership repo. A `membership-changed` RPC from the Worker invalidates it immediately on block/unblock.
- `typing` is not persisted, throttled to 1/3 s per user, auto-off after 5 s.
- After each accepted `send`, the DO: broadcasts → enqueues `push-queue` for members with no live socket → `setAlarm(now+1000)` to flush the D1 preview (debounced; one D1 write per burst, not per message).
- Backpressure: if `ws.readyState !== OPEN` or the send buffer is large, drop the socket rather than buffer unbounded.
- Idle: client pings every 30 s; DO closes sockets silent for 90 s (hibernation means an open socket is cheap, but a dead one still holds a slot).
- `react` doesn't check `members_cache` before writing (a stale reaction from a since-removed member is cosmetic, unlike a `send`) but does still require an open, authenticated socket — same as every other frame. No push/notification is enqueued for a reaction, and it does not touch the debounced D1 preview alarm.

### 2.2 `UserDO` — `/api/ws/user`
One socket per device, open for the whole session.
```ts
// server → client
| { t:'incoming_call'; callId:string; conversationId:string; from:PublicProfile }
| { t:'call_cancelled'; callId:string; reason:string }
| { t:'friend_request'; friendship:Friendship; from:PublicProfile }
| { t:'friend_accepted'; conversationId:string; peer:PublicProfile }
| { t:'unread';  conversationId:string; count:number; total:number }
| { t:'conversation_updated'; conversationId:string; preview:Preview }
// client → server
| { t:'presence'; state:'online'|'away' } | { t:'ping' }
```
`UserDO` is also what other DOs call by RPC (`env.USER.getByName(userId).notify(payload)`) to reach a user without knowing their sockets.

### 2.3 `CallDO` — `/api/ws/call/:callId`
Both peers connect; the DO relays and owns the state machine.
```ts
type SignalMsg =
  | { t:'offer';   sdp:RTCSessionDescriptionInit }
  | { t:'answer';  sdp:RTCSessionDescriptionInit }
  | { t:'ice';     candidate:RTCIceCandidateInit | null }   // null = end-of-candidates
  | { t:'accept' } | { t:'decline'; reason:'busy'|'user' }
  | { t:'bye';     reason:string }
  | { t:'stats';   relayed:boolean; rttMs:number; lossPct:number }   // on end, → Analytics Engine
```
Server adds `from: userId` (from the socket attachment) to every relayed frame; clients drop any frame whose `from` isn't the expected peer.

State machine (authoritative in the DO — clients render, they do not decide):
```
created ──(caller ws + offer)──► ringing ──accept──► connecting ──peer 'connected'──► active
   │                                │  │                                                │
   │                          decline│  │alarm t+45s                                bye │
   └──────────► ended ◄──────────────┴──┴──► missed                    failed ◄──ice fail
```
- Ring timeout is a DO **alarm** at `created+45 s`; on fire → `missed`, notify caller, push-cancel to callee (`{type:'call_cancelled', tag:'call-<id>'}` so the SW can `notification.close()`).
- On any terminal state the DO writes the final `calls` row (single writer ⇒ no race), emits an Analytics Engine data point, closes both sockets, and stops.
- Perfect negotiation: caller `polite=false`, callee `polite=true` (WHATWG pattern: `makingOffer`, `ignoreOffer`, `isSettingRemoteAnswerPending`). Remote ICE buffered until `setRemoteDescription` resolves.
- Busy: `POST /api/calls` returns `409 call/busy` if the callee has a live `ringing`/`active` call (checked via `UserDO`).

## 3. Internal DO RPC (Worker ↔ DO, never reachable from the internet)
```ts
// ConversationDO
listMessages(before: number|null, limit: number): Promise<Message[]>
appendMessage(input: SendInput & { senderId: string }): Promise<Message>
membershipChanged(members: MemberSnapshot[]): Promise<void>
stats(): Promise<{ count: number; lastSeq: number }>

// UserDO
notify(payload: UserEvent): Promise<void>   // UserEvent excludes `unread` — see bumpUnread/clearUnread
presence(): Promise<Presence>
hasLiveSocket(): Promise<boolean>         // decides push vs. no push
activeCall(): Promise<{ callId: string } | null>
// `unread`'s count/total are computed by UserDO itself (M7), not passed by the
// caller — the caller only knows "a message landed" or "the user read up to
// seq N", never the other conversations' counts needed to total them safely
// under concurrent bumps from different ConversationDOs.
bumpUnread(conversationId: string): Promise<void>   // called by ConversationDO.appendMessage for every other member
clearUnread(conversationId: string): Promise<void>  // called by POST /api/conversations/:id/read
unreadTotal(): Promise<number>                      // called by GET /api/me

// CallDO
create(input: { callerId; calleeId; conversationId }): Promise<void>
decline(userId: string, reason: string): Promise<void>
cancel(userId: string): Promise<void>

// RateLimiterDO
take(action: string, limit: number, windowMs: number): Promise<{ ok: boolean; retryAfterMs: number }>
```

## 4. Queue: `push-queue`
Producer: ConversationDO, CallDO, friend routes. Consumer: `src/server/push/consumer.ts`.
```jsonc
{ "userId":"…", "payload": { "type":"call"|"message"|"friend_request"|"call_cancelled",
  "title":"…","body":"…","tag":"call-<id>","data":{ "url":"/c/<id>" } },
  "urgency":"high"|"normal", "ttl":30 }
```
Consumer: loads subs from D1, signs VAPID JWT (ES256 via WebCrypto) + `aes128gcm` payload encryption, POSTs each endpoint. `404`/`410` → delete the row. `429`/`5xx` → `message.retry()` (max 3, then DLQ `push-dlq`). Batch size 10, max wait 5 s. **Call pushes bypass batching** — produced with `urgency:'high'`, `ttl:30`, and consumed immediately; a ring that arrives 5 s late is a failed call.

## 5. Cron Triggers
| Schedule | Job |
|---|---|
| `*/10 * * * *` | expire pending attachments >24 h (delete R2 object + row) |
| `0 * * * *` | expire invitations past `expires_at`; prune KV soft limits |
| `0 3 * * *` | reconcile `conversations` previews against ConversationDO (`stats()` drift check) |
| `0 4 * * *` | account purge jobs past their 30-day mark; retention sweeps |
| `*/5 * * * *` | orphan `ringing` calls with no DO alarm (belt-and-braces; alarms are exact but DO deletion is not guaranteed) |

## 6. Error taxonomy (shared `AppError` codes)
`auth/unauthenticated`, `auth/unverified-email`, `auth/invalid-credentials`, `auth/csrf`,
`policy/forbidden`, `policy/not-found`, `policy/blocked`,
`rate/limited`, `net/offline`, `net/timeout`,
`media/permission-denied`, `media/no-device`, `media/in-use`,
`call/busy`, `call/timeout`, `call/ice-failed`, `call/peer-left`,
`upload/too-large`, `upload/unsupported-type`, `upload/quota`, `upload/mismatch`,
`ws/stale-seq`, `ws/backpressure`.
Each maps to exactly one user-facing string in `src/client/lib/errors/messages.ts`. Raw server messages never reach the UI.
