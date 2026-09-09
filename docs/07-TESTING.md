# 07 — Testing & Quality Gates

## 1. Pyramid
| Level | Tool | Scope | Target |
|---|---|---|---|
| Static | TS strict, ESLint (incl. the layering rules), Prettier, `gitleaks` | all | zero errors |
| Unit | Vitest | pure logic: webrtc reducer, outbox, media, error mapping, zod schemas | ≥ 80% on `src/shared` + `src/client/lib` |
| **Policy** | Vitest + `@cloudflare/vitest-pool-workers` (real D1) | **every function in `src/server/policy/`** | 100%, allow **and** deny each |
| DO | vitest-pool-workers, isolated per-test storage | ConversationDO, CallDO, RateLimiterDO, UserDO | state machines + alarms |
| API | vitest-pool-workers `SELF.fetch()` | every route: happy, unauthorized, cross-tenant | 100% of routes have a cross-tenant deny test |
| Component | Vitest + Testing Library + MSW | composer, bubbles, call controls, permission cards | key states |
| E2E | Playwright (chromium, 2 contexts) | full flows against `wrangler dev` | happy + 6 failure paths |
| Perf | Lighthouse CI | budgets from 06 §5 | gate on PR |
| Manual | real Chromebook + phone | audio, devices, notifications | pre-release checklist |

## 2. Policy tests — the load-bearing suite
D1 has no RLS, so this suite **is** the security boundary. `src/server/policy/*.test.ts`, real D1 via the Workers pool, seeded with users A, B (friends), C (stranger), D (blocked by A).

For each policy function assert:
- allow: the legitimate actor succeeds
- deny(stranger): C is rejected with `policy/not-found` (not 403 — no existence leak)
- deny(blocked): D is rejected with `policy/blocked`
- deny(spoof): a body field claiming another `userId` changes nothing
- deny(unverified): an unverified-email actor is rejected on invite/message/call

Plus a **route coverage guard** in CI:
```bash
# every file in src/server/routes must import from ../policy
comm -23 <(ls src/server/routes/*.ts | sort) \
         <(grep -rl "from '\.\./policy'" src/server/routes | sort) \
  | tee /dev/stderr | wc -l | grep -qx 0
```
A route with no policy import fails the build. Crude, and it has caught real misses.

## 3. Durable Object tests
```ts
import { env, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';

it('dedupes on clientId', async () => {
  const stub = env.CONVERSATION.getByName('conv-1');
  const a = await stub.appendMessage({ clientId: 'k1', senderId: 'u1', kind: 'text', body: 'hi' });
  const b = await stub.appendMessage({ clientId: 'k1', senderId: 'u1', kind: 'text', body: 'hi' });
  expect(b.seq).toBe(a.seq);
});

it('rings out after 45s', async () => {
  const stub = env.CALL.getByName('call-1');
  await stub.create({ callerId:'u1', calleeId:'u2', conversationId:'c1' });
  expect(await runDurableObjectAlarm(stub)).toBe(true);          // alarm fired
  await runInDurableObject(stub, async (_i, ctx) => {
    expect((await ctx.storage.get<CallState>('state'))!.status).toBe('missed');
  });
});
```
Cover: gapless `seq` under concurrent appends, backfill cap and `hasMore`, typing throttle, membership cache invalidation on `membershipChanged`, hibernation round-trip (`serializeAttachment` survives), D1 preview alarm debounce (N sends ⇒ 1 write), rate limiter window rollover, call state machine including glare and double-`bye`.

## 4. WebRTC testing
- **Unit**: negotiation is a pure reducer over `SignalMsg` + connection state. Test with a fake `pc`: glare (simultaneous offers), out-of-order ICE, ICE before remote description, duplicate offer, `bye` during connecting, ICE restart exhaustion.
- **E2E**: Playwright, two contexts, flags:
  ```
  --use-fake-device-for-media-stream --use-fake-ui-for-media-stream
  --autoplay-policy=no-user-gesture-required
  ```
  Assert both reach `connectionState === 'connected'`, `getStats()` shows inbound `bytesReceived > 0`, and after hangup every track is `ended` and `pc.signalingState === 'closed'`.
- **Relay path**: nightly job forcing `iceTransportPolicy:'relay'` against real TURN creds — proves credential minting and the relay route work. Not per-PR (bandwidth).
- **Network shaping**: CDP `Network.emulateNetworkConditions` for a slow-link smoke test.

## 5. E2E scenarios
1. Signup → verification mail (local mail catcher) → profile setup
2. Invite an unregistered email → open token link → signup → auto-friendship + conversation
3. Invite a registered user → accept → conversation appears for both
4. Text both directions: receipts, typing indicator, unread badge
5. File (2 MB pdf) + image from picker → peer downloads; 26 MB rejected
6. Voice message record → send → peer plays with waveform
7. Call: place, accept, 3 s audio, hang up; both see "Call ended · 0:03"
8. Decline → "Declined"; no answer → alarm fires → "Missed call"
9. Offline: 3 messages queued → reconnect → flushed in order, **zero duplicates**
10. Block: A blocks B → B's send returns `policy/blocked`, call returns 403, presence hidden
11. Reload during an active call → call ends cleanly, no orphaned mic track
12. Push: call while the receiver's tab is hidden → notification with Accept/Decline (headed run)
13. **Gap-fill**: kill the socket, insert messages via the HTTP path from the peer, reconnect → `hello{lastSeq}` backfills exactly the missing range, no dupes, no holes

## 6. CI pipeline (`.github/workflows/ci.yml`)
```
on: [pull_request, push:main]
jobs:
  quality:  typecheck → lint (layering rules) → gitleaks → unit → build
  worker:   vitest-pool-workers (policy + DO + API suites, local D1 migrations applied)
  guards:   route-policy coverage guard → bundle-size budget → no-drizzle-outside-repos grep
  e2e:      wrangler dev (local D1/R2/DO) → playwright → upload traces
  perf:     lighthouse-ci against the preview URL
  deploy:   main only → d1 migrations apply --remote → wrangler deploy
```
Branch protection: all jobs required, 1 review, linear history.

## 7. Definition of Done (per feature)
- [ ] zod schema in `src/shared/` used by both route and client
- [ ] policy function + allow/deny tests in the same PR
- [ ] D1 migration generated (not hand-edited) with a rollback migration if destructive
- [ ] Loading, empty, error, and offline states implemented
- [ ] Keyboard + screen-reader pass (axe check green)
- [ ] DO changes covered by a vitest-pool-workers test, alarms included
- [ ] No new console errors/warnings; no CSP violations
- [ ] Bundle delta reported; > 10 KB gzip needs justification
- [ ] Docs updated when a contract changed

## 8. Observability
- **Workers Logs** (`observability.enabled`) with structured lines: `{ req, route, userId, ms, ok, code }`. Sampling 100% at launch, tune later.
- **Sentry** browser + Worker (`@sentry/cloudflare`), PII scrubbed, `replaysOnErrorSampleRate: 1.0`.
- **Analytics Engine** `call_metrics` data point on every call end: blobs `[end_reason, relayed, region]`, doubles `[setup_ms, duration_s, avg_rtt_ms, loss_pct]`, index = hashed user id. Dashboard: connect-success rate, p50/p95 setup, relay share, drop rate.
- **Alerts**: connect-success < 95% over 1 h · push failure rate > 10% · Worker 5xx > 1% · D1 query p95 > 100 ms · DO storage per conversation > 40 MB.
