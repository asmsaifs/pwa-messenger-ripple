import { DurableObject } from 'cloudflare:workers';
import { conversationStub } from '../server/lib/conversation-do';
import { enqueuePush } from '../server/lib/push-queue';
import { userStub } from '../server/lib/user-do';
import * as callsRepo from '../server/repos/calls';
import * as profilesRepo from '../server/repos/profiles';
import { callSignalFrameSchema, type CallLiveStatus, type CallStatus } from '../shared/calls';
import type { UserEvent, PublicProfile } from '../shared/user-events';
import type { Env } from '../server/env';

// Per-socket attachment (docs/01 §5) — identity comes only from here, never
// from a frame body; set once at `fetch` after the Worker route's policy
// check already ran (`policy.assertCanActOnCall`), same trust boundary as
// ConversationDO/UserDO.
type Attachment = { userId: string; callId: string; lastSeenAt: number };

// docs/02 §3: CallDO's state is a small JSON shape, not a `CREATE TABLE`
// block — plain `ctx.storage.get/put`, not `ctx.storage.sql` (unlike
// ConversationDO/RateLimiterDO).
type CallState = {
  callId: string;
  conversationId: string;
  callerId: string;
  calleeId: string;
  status: CallLiveStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  endReason?: string;
  relayed?: boolean;
};

const RING_TIMEOUT_MS = 45_000;
const TERMINAL_STATUSES: CallLiveStatus[] = ['ended', 'missed', 'declined', 'failed'];

function isTerminal(status: CallLiveStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

// Voice call signaling relay + state machine (docs/01 §4.3, docs/03 §2.3,
// docs/09 M13). One instance per call, addressed via `idFromName(callId)`
// (see src/server/lib/rate-limit.ts's comment on the pinned Miniflare gap —
// not `getByName`). The DO is the *only* writer of `calls.status` (CLAUDE.md
// hard rule 9's "persist before mutating in-memory state" + docs/01 §4.3):
// every state transition below persists to `ctx.storage` before it's acted
// on, so a mid-call eviction can't lose or duplicate a transition.
export class CallDO extends DurableObject<Env> {
  private state: CallState | null = null;
  private loaded: Promise<void>;
  // "on end, → Analytics Engine" (docs/03 §2.3) — the client sends this
  // alongside/just before `bye`; last-writer-wins is fine since only the
  // hanging-up side typically reports it.
  private pendingStats: { relayed: boolean; rttMs: number; lossPct: number } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Schema init only (CLAUDE.md hard rule 9) — constructors can't be async,
    // so this is intentionally not awaited; every method below awaits
    // `this.loaded` first instead.
    this.loaded = ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<CallState>('state');
      if (stored) this.state = stored;
    });
  }

  private async persist(): Promise<void> {
    if (this.state) await this.ctx.storage.put('state', this.state);
  }

  private systemActor(userId: string) {
    return { userId, sessionId: '', emailVerified: true };
  }

  private async publicProfile(userId: string): Promise<PublicProfile> {
    const profile = await profilesRepo
      .getProfile(this.env, this.systemActor(userId), userId)
      .catch(() => undefined);
    return {
      userId,
      displayName: profile?.displayName ?? 'Someone',
      avatarKey: profile?.avatarKey ?? null,
      statusText: profile?.statusText ?? null,
    };
  }

  private async notifyUserDO(userId: string, event: UserEvent): Promise<void> {
    try {
      await userStub(this.env, userId).notify(event);
    } catch (err) {
      console.error('CallDO: UserDO.notify failed', err);
    }
  }

  // Push-cancel (docs/03 §2.3: "push-cancel to callee ... so the SW can
  // `notification.close()`") — same `tag` as the original `call` push, which
  // is how a service worker's `notification.close()` finds it to dismiss.
  private async pushCancel(userId: string): Promise<void> {
    if (!this.state) return;
    try {
      await enqueuePush(
        this.env,
        userId,
        {
          type: 'call_cancelled',
          title: 'Missed call',
          body: '',
          tag: `call-${this.state.callId}`,
          data: { url: `/call/${this.state.callId}` },
        },
        { urgency: 'high', ttl: 30 },
      );
    } catch (err) {
      console.error('CallDO: push-cancel enqueue failed', err);
    }
  }

  // ── RPC: create (docs/03 §3) ─────────────────────────────────────────────
  async create(input: { callerId: string; calleeId: string; conversationId: string }): Promise<void> {
    await this.loaded;
    if (this.state) return; // idempotent: a retried route call must not reset an in-flight call
    const callId = this.ctx.id.toString();
    this.state = {
      callId,
      conversationId: input.conversationId,
      callerId: input.callerId,
      calleeId: input.calleeId,
      status: 'ringing',
      createdAt: Date.now(),
    };
    await this.persist();
    await this.ctx.storage.setAlarm(Date.now() + RING_TIMEOUT_MS);

    const hasLiveSocket = await userStub(this.env, input.calleeId)
      .hasLiveSocket()
      .catch(() => false);
    const from = await this.publicProfile(input.callerId);
    if (hasLiveSocket) {
      await this.notifyUserDO(input.calleeId, {
        t: 'incoming_call',
        callId,
        conversationId: input.conversationId,
        from,
      });
    } else {
      try {
        await enqueuePush(
          this.env,
          input.calleeId,
          {
            type: 'call',
            title: from.displayName,
            body: 'Incoming call',
            tag: `call-${callId}`,
            data: { url: `/call/${callId}` },
          },
          { urgency: 'high', ttl: 30 },
        );
      } catch (err) {
        console.error('CallDO: incoming-call push enqueue failed', err);
      }
    }
  }

  // ── RPC: decline / cancel (docs/03 §3) — the REST-route paths, which have
  // no live CallDO socket to assume (a push notification's Decline action,
  // or the caller closing the app before the callee ever connects). The WS
  // `decline`/`bye` frame handlers below funnel into these same methods so
  // both paths converge on one state-transition implementation.
  async decline(userId: string, reason: string): Promise<void> {
    await this.loaded;
    if (!this.state || userId !== this.state.calleeId) return;
    if (isTerminal(this.state.status)) return; // already resolved — double-decline no-ops
    this.relay({ t: 'decline', reason }, userId);
    await this.notifyUserDO(this.state.callerId, {
      t: 'call_cancelled',
      callId: this.state.callId,
      reason,
    });
    await this.endCall('declined', reason);
  }

  async cancel(userId: string): Promise<void> {
    await this.loaded;
    if (!this.state || userId !== this.state.callerId) return;
    if (this.state.status !== 'ringing') return; // past ringing: caller should `bye` instead
    await this.notifyUserDO(this.state.calleeId, {
      t: 'call_cancelled',
      callId: this.state.callId,
      reason: 'cancelled',
    });
    await this.pushCancel(this.state.calleeId);
    await this.endCall('missed', 'caller_cancelled');
  }

  // ── fetch: WS upgrade only ──────────────────────────────────────────────
  override async fetch(request: Request): Promise<Response> {
    await this.loaded;
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 });
    }
    // Set only by the Worker route after `requireAuth` + `policy.assertCanActOnCall`
    // already ran (docs/01 §5) — never trusted from anywhere else.
    const url = new URL(request.url);
    const userId = url.searchParams.get('actorUserId');
    if (!userId) return new Response('missing actor', { status: 400 });
    if (!this.state) return new Response('call not found', { status: 404 });
    if (userId !== this.state.callerId && userId !== this.state.calleeId) {
      return new Response('not a participant', { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [`user:${userId}`]);
    server.serializeAttachment({
      userId,
      callId: this.state.callId,
      lastSeenAt: Date.now(),
    } satisfies Attachment);
    this.sendFrame(server, { t: 'state', status: this.state.status });

    return new Response(null, { status: 101, webSocket: client });
  }

  private sendFrame(ws: WebSocket, frame: unknown): void {
    if (ws.readyState !== WebSocket.READY_STATE_OPEN) return; // backpressure/closed: drop, don't buffer
    ws.send(JSON.stringify(frame));
  }

  private otherPartySockets(senderId: string): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      return attachment !== null && attachment.userId !== senderId;
    });
  }

  // "Server adds `from: userId` ... to every relayed frame; clients drop any
  // frame whose `from` isn't the expected peer" (docs/03 §2.3) — relay only
  // ever targets the other participant's socket(s), never an echo back to
  // the sender.
  private relay(frame: object, fromUserId: string): void {
    const wire = { ...frame, from: fromUserId };
    for (const ws of this.otherPartySockets(fromUserId)) this.sendFrame(ws, wire);
  }

  private broadcastState(status: CallLiveStatus): void {
    for (const ws of this.ctx.getWebSockets()) this.sendFrame(ws, { t: 'state', status });
  }

  // ── hibernation handlers ────────────────────────────────────────────────
  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await this.loaded;
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment || !this.state) {
      ws.close(1011, 'no attachment');
      return;
    }
    attachment.lastSeenAt = Date.now();
    ws.serializeAttachment(attachment);

    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      this.sendFrame(ws, { t: 'error', code: 'validation/invalid', message: 'malformed frame' });
      return;
    }
    const result = callSignalFrameSchema.safeParse(parsed);
    if (!result.success) {
      this.sendFrame(ws, { t: 'error', code: 'validation/invalid', message: 'malformed frame' });
      return;
    }
    const frame = result.data;
    const userId = attachment.userId;

    switch (frame.t) {
      case 'ping':
        this.sendFrame(ws, { t: 'pong' });
        return;
      case 'offer':
      case 'ice':
        // Pure relay — glare (both sides sending an offer) and out-of-order
        // ICE are the client's perfect-negotiation reducer's job to resolve
        // (docs/03 §2.3, docs/10 §3's M13 seed), not the DO's.
        this.relay(frame, userId);
        return;
      case 'accept':
        if (userId !== this.state.calleeId) return; // only the callee accepts
        if (this.state.status === 'ringing') {
          await this.ctx.storage.deleteAlarm();
          this.state.status = 'connecting';
          await this.persist();
          this.broadcastState('connecting');
        }
        this.relay(frame, userId);
        return;
      case 'answer':
        this.relay(frame, userId);
        // The SDP answer is the closest observable "call established" signal
        // this protocol exposes (no separate `connected` frame exists) — the
        // DO transitions here rather than waiting on a client-reported ICE
        // state, since it's the single writer of `calls.status` and needs a
        // concrete event to write against.
        if (this.state.status === 'connecting') {
          this.state.status = 'active';
          this.state.startedAt = Date.now();
          await this.persist();
          await callsRepo
            .updateCallStatus(this.env, this.systemActor(this.state.callerId), this.state.callId, {
              status: 'active',
              startedAt: this.state.startedAt,
            })
            .catch((err) => console.error('CallDO: updateCallStatus(active) failed', err));
          this.broadcastState('active');
        }
        return;
      case 'decline':
        await this.decline(userId, frame.reason);
        return;
      case 'bye':
        if (this.state.status === 'ringing' && userId === this.state.callerId) {
          await this.cancel(userId);
          return;
        }
        if (isTerminal(this.state.status)) return; // double-`bye` no-ops
        this.relay(frame, userId);
        await this.endCall('ended', frame.reason);
        return;
      case 'stats':
        this.pendingStats = { relayed: frame.relayed, rttMs: frame.rttMs, lossPct: frame.lossPct };
        return;
    }
  }

  override webSocketClose(): void {
    // No durable state to update on a mere socket close — a peer dropping
    // mid-call is expected to reconnect within the client's ICE-restart
    // window (docs/01 §4.3), not treated as an immediate `bye`; the call
    // only ends on an explicit `bye`/`decline` frame or the ring alarm.
  }

  override webSocketError(_ws: WebSocket, error: unknown): void {
    console.error('CallDO websocket error', error);
  }

  // ── terminal transition: single writer of the final `calls` row ─────────
  private async endCall(status: 'ended' | 'missed' | 'declined' | 'failed', endReason: string): Promise<void> {
    if (!this.state || isTerminal(this.state.status)) return; // idempotent
    const now = Date.now();
    this.state.status = status;
    this.state.endedAt = now;
    this.state.endReason = endReason;
    if (this.pendingStats) this.state.relayed = this.pendingStats.relayed;
    await this.persist();

    await callsRepo
      .updateCallStatus(this.env, this.systemActor(this.state.callerId), this.state.callId, {
        status,
        ...(this.state.startedAt !== undefined ? { startedAt: this.state.startedAt } : {}),
        endedAt: now,
        endReason,
        ...(this.state.relayed !== undefined ? { iceRelayed: this.state.relayed } : {}),
      })
      .catch((err) => console.error('CallDO: updateCallStatus(final) failed', err));

    await this.writeAnalytics(status, endReason);
    await this.appendCallEventMessage(status);
    this.broadcastState(status);
    await this.ctx.storage.deleteAlarm().catch(() => {});
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, status);
      } catch {
        // already closed
      }
    }
  }

  private async hashUserId(userId: string): Promise<string> {
    // "index = hashed user id" (docs/07 §8) — salted with the existing
    // session secret rather than a dedicated rotating salt (docs/05 §9's
    // full rotation scheme is bigger than this milestone needs); still never
    // reversible back to a raw user id from the Analytics Engine dataset.
    const data = new TextEncoder().encode(`${this.env.BETTER_AUTH_SECRET}:${userId}`);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)]
      .slice(0, 16)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // docs/07 §8, verbatim: "Analytics Engine `call_metrics` data point on
  // every call end: blobs [end_reason, relayed, region], doubles [setup_ms,
  // duration_s, avg_rtt_ms, loss_pct], index = hashed user id."
  private async writeAnalytics(status: CallStatus, endReason: string): Promise<void> {
    if (!this.state) return;
    const setupMs = this.state.startedAt ? this.state.startedAt - this.state.createdAt : 0;
    const durationS =
      this.state.startedAt && this.state.endedAt
        ? (this.state.endedAt - this.state.startedAt) / 1000
        : 0;
    try {
      const indexHash = await this.hashUserId(this.state.callerId);
      this.env.ANALYTICS.writeDataPoint({
        blobs: [endReason, this.state.relayed ? 'relay' : 'p2p', status],
        doubles: [setupMs, durationS, this.pendingStats?.rttMs ?? 0, this.pendingStats?.lossPct ?? 0],
        indexes: [indexHash],
      });
    } catch (err) {
      console.error('CallDO: Analytics Engine write failed', err);
    }
  }

  // Appends a `call_event` message into the conversation thread (docs/02 §2's
  // `kind` enum, docs/04 §2.1's preview copy) so call history shows inline
  // like any other message. Best-effort: a failure here must not block the
  // state transition that already succeeded.
  private async appendCallEventMessage(status: CallStatus): Promise<void> {
    if (!this.state) return;
    const body =
      status === 'ended' && this.state.startedAt
        ? `Call ended · ${formatDuration((this.state.endedAt! - this.state.startedAt) / 1000)}`
        : status === 'missed'
          ? 'Missed call'
          : status === 'declined'
            ? 'Declined'
            : 'Call failed';
    try {
      await conversationStub(this.env, this.state.conversationId).appendMessage({
        clientId: `call-event-${this.state.callId}`,
        senderId: this.state.callerId,
        kind: 'call_event',
        body,
        conversationId: this.state.conversationId,
      });
    } catch (err) {
      console.error('CallDO: appendCallEventMessage failed', err);
    }
  }

  // ── alarm: ring timeout only (docs/03 §2.3) ─────────────────────────────
  override async alarm(): Promise<void> {
    await this.loaded;
    if (!this.state || this.state.status !== 'ringing') return; // already progressed — no-op
    await this.notifyUserDO(this.state.callerId, {
      t: 'call_cancelled',
      callId: this.state.callId,
      reason: 'timeout',
    });
    await this.pushCancel(this.state.calleeId);
    await this.endCall('missed', 'timeout');
  }
}
