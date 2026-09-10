import { DurableObject } from 'cloudflare:workers';
import * as callsRepo from '../server/repos/calls';
import { userClientFrameSchema, type PresenceState, type UserEvent } from '../shared/user-events';
import type { Env } from '../server/env';

// Per-socket attachment (docs/01 §5) — survives hibernation, never trusted as
// identity from anywhere else (the Worker route already ran `requireAuth`
// before forwarding the upgrade, same trust boundary as ConversationDO).
type Attachment = { userId: string; lastSeenAt: number };

const IDLE_CLOSE_MS = 90_000;

// Personal event bus + presence + unread counts (docs/01 §6, docs/02 §3): one
// instance per user, addressed via `idFromName(userId)` (see
// src/server/lib/rate-limit.ts's comment on the pinned Miniflare gap — not
// `getByName` despite CLAUDE.md hard rule 9 and the docs' prose). Docs/02 §3
// types this DO's state as a small JSON shape ("KV storage: presence, unread
// counts"), unlike ConversationDO/RateLimiterDO which get literal `CREATE
// TABLE` blocks — so this uses plain `ctx.storage.get/put`, not `ctx.storage.sql`.
export class UserDO extends DurableObject<Env> {
  private presenceState: PresenceState = 'offline';
  private lastSeenAt = 0;
  private unread: Record<string, number> = {};
  private loaded: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Schema init only (CLAUDE.md hard rule 9) — constructors can't be async,
    // so this is intentionally not awaited; every method below awaits
    // `this.loaded` first instead, which queues behind the same promise.
    this.loaded = ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<{
        presence: PresenceState;
        lastSeenAt: number;
        unread: Record<string, number>;
      }>('state');
      if (stored) {
        this.presenceState = stored.presence;
        this.lastSeenAt = stored.lastSeenAt;
        this.unread = stored.unread;
      }
    });
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put('state', {
      presence: this.presenceState,
      lastSeenAt: this.lastSeenAt,
      unread: this.unread,
    });
  }

  private totalUnread(): number {
    return Object.values(this.unread).reduce((sum, n) => sum + n, 0);
  }

  // ── fetch: WS upgrade only ──────────────────────────────────────────────
  override async fetch(request: Request): Promise<Response> {
    await this.loaded;
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 });
    }
    // Set only by the Worker route after `requireAuth` (docs/01 §5) — the
    // route never adds a `:id` param since the personal socket is always
    // self-scoped, so there's nothing else to re-check membership against.
    const url = new URL(request.url);
    const userId = url.searchParams.get('actorUserId');
    if (!userId) return new Response('missing actor', { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [`user:${userId}`]);
    const now = Date.now();
    server.serializeAttachment({ userId, lastSeenAt: now } satisfies Attachment);

    this.presenceState = 'online';
    this.lastSeenAt = now;
    await this.persist();
    await this.ctx.storage.setAlarm(now + IDLE_CLOSE_MS / 3);

    return new Response(null, { status: 101, webSocket: client });
  }

  private sendFrame(ws: WebSocket, frame: unknown): void {
    if (ws.readyState !== WebSocket.READY_STATE_OPEN) return; // backpressure/closed: drop, don't buffer
    ws.send(JSON.stringify(frame));
  }

  private broadcast(frame: unknown): void {
    for (const ws of this.ctx.getWebSockets()) this.sendFrame(ws, frame);
  }

  // ── hibernation handlers ────────────────────────────────────────────────
  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await this.loaded;
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) {
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
    const result = userClientFrameSchema.safeParse(parsed);
    if (!result.success) {
      this.sendFrame(ws, { t: 'error', code: 'validation/invalid', message: 'malformed frame' });
      return;
    }
    const frame = result.data;

    switch (frame.t) {
      case 'ping':
        this.sendFrame(ws, { t: 'pong' });
        return;
      case 'presence':
        this.presenceState = frame.state;
        this.lastSeenAt = Date.now();
        await this.persist();
        return;
    }
  }

  override async webSocketClose(): Promise<void> {
    await this.loaded;
    // Last socket for this user just closed — go offline. A tab refresh
    // reconnects fast enough (docs/04 §4.2 backoff) that this briefly
    // flickering to 'offline' between the old socket closing and the new one
    // opening is an accepted tradeoff, not a bug to chase.
    if (this.ctx.getWebSockets().length === 0) {
      this.presenceState = 'offline';
      this.lastSeenAt = Date.now();
      await this.persist();
    }
  }

  override webSocketError(_ws: WebSocket, error: unknown): void {
    console.error('UserDO websocket error', error);
  }

  // ── RPC contract (docs/03 §3) ───────────────────────────────────────────
  hasLiveSocket(): boolean {
    return this.ctx.getWebSockets().length > 0;
  }

  async presence(): Promise<{ state: PresenceState; lastSeenAt: number }> {
    await this.loaded;
    return { state: this.presenceState, lastSeenAt: this.lastSeenAt };
  }

  async activeCall(): Promise<{ callId: string } | null> {
    const call = await callsRepo.getOpenCall(this.env, this.actorUserIdFromAttachment());
    return call ? { callId: call.id } : null;
  }

  // `activeCall` is the one RPC that needs "which user is this" outside a
  // request/attachment context (a WS frame or `fetch` URL) — every live
  // socket carries the same userId in its attachment, so the first one found
  // is authoritative; with none connected there's nothing to look up (no
  // durable fallback is needed since a disconnected user can't be "busy" from
  // this DO's perspective — `assertCanStartCall` checks D1 directly instead).
  private actorUserIdFromAttachment(): string {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment) return attachment.userId;
    }
    throw new Error('UserDO.activeCall called with no live socket to resolve userId from');
  }

  // Transient events (docs/03 §2.2) — pushed to every live socket for this
  // user (multi-device fan-out) with no durable state of their own. Silently
  // a no-op if nothing is connected: callers decide push-vs-notification
  // fallback via `hasLiveSocket` before calling this (docs/03 §3).
  notify(event: UserEvent): void {
    this.broadcast(event);
  }

  // Called by ConversationDO after appending a message (docs/01 §4, the
  // fan-in path via `env.USER.get(...)`) — increments this conversation's
  // count and recomputes the total server-side rather than trusting a
  // caller-supplied count, so concurrent bumps from different conversations
  // can't race each other into a wrong total.
  async bumpUnread(conversationId: string): Promise<void> {
    await this.loaded;
    this.unread[conversationId] = (this.unread[conversationId] ?? 0) + 1;
    await this.persist();
    this.broadcast({
      t: 'unread',
      conversationId,
      count: this.unread[conversationId],
      total: this.totalUnread(),
    });
  }

  // Called by `POST /api/conversations/:id/read` once the D1 read marker is
  // set — zeroes this conversation's count so a second, already-open tab
  // sees the same badge the acting tab does (docs/09 M7 exit criterion).
  async clearUnread(conversationId: string): Promise<void> {
    await this.loaded;
    if (!(conversationId in this.unread)) return;
    delete this.unread[conversationId];
    await this.persist();
    this.broadcast({ t: 'unread', conversationId, count: 0, total: this.totalUnread() });
  }

  async unreadTotal(): Promise<number> {
    await this.loaded;
    return this.totalUnread();
  }

  // Account-deletion purge (docs/05 §9, M15): this DO is 1:1 with the user,
  // so wiping its storage is the whole job — unlike ConversationDO, which is
  // shared with the other member and needs per-user tombstoning instead of a
  // full wipe. Closes any live sockets first so a stale tab doesn't keep
  // writing to `state` after storage is gone.
  async purge(): Promise<void> {
    await this.loaded;
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, 'account deleted');
    await this.ctx.storage.deleteAll();
    this.presenceState = 'offline';
    this.lastSeenAt = 0;
    this.unread = {};
  }

  // ── alarm: idle-socket sweep only (no D1 writer here, unlike ConversationDO) ──
  override async alarm(): Promise<void> {
    const now = Date.now();
    let anySocketRemains = false;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment && now - attachment.lastSeenAt > IDLE_CLOSE_MS) {
        ws.close(1000, 'idle');
      } else {
        anySocketRemains = true;
      }
    }
    if (anySocketRemains) {
      await this.ctx.storage.setAlarm(now + IDLE_CLOSE_MS / 3);
    }
  }
}
