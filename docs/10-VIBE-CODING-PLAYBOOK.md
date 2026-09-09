# 10 — Vibe Coding Playbook

How to drive this build with an AI agent without producing an unmaintainable pile.

## 1. The loop
```
1. Pick ONE milestone from 09-ROADMAP.
2. Paste the milestone prompt (below) + say "read docs/ first".
3. Agent writes tests first for the risky logic, then implementation.
4. Run: pnpm typecheck && pnpm lint && pnpm test && pnpm e2e:<feature>
5. YOU manually exercise the feature in the browser. Every time.
6. Review the diff: policy check present? error states? tracks stopped? secrets clean?
7. Commit small, squash-merge, update docs/ if a contract changed.
8. /clear context. Next milestone.
```
Rules that keep quality from decaying:
- **One milestone per session.** Long sessions drift; the agent starts re-inventing what already exists.
- **Never accept a green build you didn't run yourself.**
- **Docs are the spec.** If the agent proposes something contradicting `docs/`, either update the doc first or reject the change. Ambiguity resolved in chat is lost; ambiguity resolved in `docs/` compounds.
- **Reject "I'll mock this for now"** in M4+ — mocks that ship become the architecture.
- Ask for a **plan before code** on M11 and M6 specifically.

## 2. Prompt template
```
Read docs/00 through docs/10. Implement milestone M<N>: <name>.

Constraints:
- Follow docs/01 §7 repo layout exactly. Drizzle/`env.DB` only in src/server/repos/.
- Every route calls a policy function; every policy function ships with an allow test AND a deny test in the same change.
- Request/response shapes are zod schemas in src/shared/, imported by both sides.
- Every async UI path implements loading, empty, error, and offline states.
- No new dependency without stating why in the PR description.
- TypeScript strict; no `any`, no non-null `!` without a comment.

Deliver in this order:
1. A short plan (files to create/modify, key decisions, open questions).
2. Tests for the non-obvious logic.
3. Implementation.
4. The manual verification steps I should run.

Exit criteria (from docs/09): <paste row>
Stop and ask if a decision would contradict docs/.
```

## 3. Per-milestone prompt seeds
- **M1**: "Write the Drizzle schema from docs/02 §1, generate migration 0001 with drizzle-kit (do not hand-write it), and a seed script with 4 test users: A+B friends, C stranger, D blocked by A. Then the repos with the `actor` first-arg convention."
- **M2**: "Implement docs/02 §5 as pure functions in src/server/policy/. This replaces database RLS — it is the only authorization layer, so write the deny tests first: stranger, blocked, spoofed-body-userId, unverified-email. Then the route-policy CI guard from docs/07 §2."
- **M6**: "ConversationDO first, UI second. Use the WebSocket Hibernation API. The hard parts, in order: gapless seq under concurrent appends; UNIQUE(client_id) dedupe; the hello/backfill gap-fill handshake; membership cache invalidation; the debounced D1 preview alarm (N sends must produce 1 D1 write, prove it in a test)."
- **M8**: "Outbox is a state machine: pending → sending → sent | failed. Dedupe by `clientId` against the DO's UNIQUE index. Test: 3 concurrent flush attempts produce exactly one message."
- **M11**: "Feature-detect MediaRecorder mimeTypes. Always `track.stop()` in a finally block — a leaked mic track leaves the Chrome OS recording indicator on and is a trust bug."
- **M13**: "Plan first, no code. CallDO owns the state machine and is the only writer of the calls row; the ring timeout is a DO alarm at +45s, not a cron. Implement perfect negotiation per docs/03 §2.3 as a pure reducer in src/client/lib/webrtc/, testable without a real RTCPeerConnection; React only wires it up."
- **M14**: "Call push must use urgency:'high', TTL 30s, requireInteraction, and bypass queue batching. notificationclick must focus the existing window (launch_handler navigate-existing) — never openWindow if a client exists. A cancelled call sends a call_cancelled push so the SW can close the stale notification."

## 4. Review checklist for every AI-generated diff
- [ ] Does any route reach data without calling a policy function?
- [ ] Does anything outside `repos/` import Drizzle or touch `env.DB`?
- [ ] Does any handler read identity from a request body instead of the session or socket attachment?
- [ ] Any secret, service-role key, or TURN secret reachable from the client bundle?
- [ ] Are `MediaStreamTrack`s and `RTCPeerConnection`s closed on every exit path (incl. errors and unmount)?
- [ ] Are WebSockets closed and listeners removed on unmount? (leak = duplicate handlers = duplicate messages)
- [ ] Do DO changes stay additive so a gradual rollout with two code versions is safe?
- [ ] `useEffect` deps honest — no eslint-disable on exhaustive-deps without a comment
- [ ] Errors mapped to `AppError` codes, not raw strings in UI
- [ ] Anything cached in the SW that shouldn't be (auth'd data)?
- [ ] New deps: size, maintenance, license
- [ ] Dead code / duplicated helper that already exists in `src/lib`?

## 5. Anti-patterns to reject on sight
- Filtering by `user_id` in the client as the *only* authorization.
- Trusting the DO trust boundary as authorization (it is a perimeter, not a check — the DO re-verifies).
- `select('*')` on `profiles` joined into every query (leaks fields, bloats payload).
- Storing WebRTC objects in React state (they're not serializable; use refs + a Zustand store for status only).
- A second `RTCPeerConnection` created by a re-render.
- `setInterval` polling where a Realtime subscription exists.
- Global `try {} catch {}` that swallows errors silently.
- Inline base64 media in D1 instead of R2.
- A Durable Object that holds critical state only in memory (lost on eviction).
- `blockConcurrencyWhile` on a hot path (it serializes everything).
- A single global DO for all conversations (bottleneck) — one DO per conversation, always.
- Non-hibernating WebSockets (`server.accept()` instead of `ctx.acceptWebSocket()`) — bills you for idle sockets.
- Auto `skipWaiting()` in the SW (reloads users mid-call).

## 6. Context hygiene
Keep `CLAUDE.md` at repo root short (see file) and let it point at `docs/`. Re-read the relevant doc at the start of each session rather than trusting summarized memory. When a doc and the code disagree, fix the doc in the same PR.
