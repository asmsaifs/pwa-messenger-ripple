import { DurableObject } from 'cloudflare:workers';
import { AppError } from '../server/errors';
import { enqueuePush } from '../server/lib/push-queue';
import { takeRateLimit } from '../server/lib/rate-limit';
import { userStub } from '../server/lib/user-do';
import * as conversationsRepo from '../server/repos/conversations';
import * as profilesRepo from '../server/repos/profiles';
import {
  clientFrameSchema,
  previewTextFor,
  MESSAGE_BODY_MAX_LENGTH,
  type Message,
  type SendMessageInput,
} from '../shared/messages';
import { uuidv7 } from '../shared/id';
import type { Env } from '../server/env';

// Per-socket state that must survive hibernation — kept in the WS attachment
// (docs/01 §5), never in a JS field, since hibernation evicts in-memory state
// between messages but preserves `serializeAttachment` data.
type Attachment = { userId: string; conversationId: string; lastSeenAt: number };

type MemberSnapshot = { userId: string; status: 'member' | 'removed' };

const BACKFILL_CAP = 500;
const TYPING_THROTTLE_MS = 3_000;
const IDLE_CLOSE_MS = 90_000;
const PREVIEW_FLUSH_DEBOUNCE_MS = 1_000;
const MEMBERSHIP_CACHE_TTL_MS = 60_000;
const RATE_LIMIT_PER_CONVERSATION = { limit: 30, windowMs: 10_000 };
const RATE_LIMIT_PER_USER = { limit: 300, windowMs: 60 * 60_000 };

type MessageRow = {
  seq: number;
  id: string;
  client_id: string;
  sender_id: string;
  kind: string;
  body: string | null;
  attachment_id: string | null;
  call_id: string | null;
  reply_to_seq: number | null;
  deleted_at: number | null;
  created_at: number;
};

function rowToMessage(row: MessageRow): Message {
  return {
    seq: row.seq,
    id: row.id,
    clientId: row.client_id,
    senderId: row.sender_id,
    kind: row.kind as Message['kind'],
    body: row.body,
    attachmentId: row.attachment_id,
    callId: row.call_id,
    replyToSeq: row.reply_to_seq,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
  };
}

// Text-chat backbone (docs/01 §3/§4/§6, docs/02 §2, docs/03 §2/§3). One
// instance per conversation (addressed via `idFromName`, not `getByName` —
// see src/server/lib/rate-limit.ts's comment on the pinned Miniflare gap),
// SQLite is the single writer for messages/receipts/typing so `seq` is
// gapless without cross-DO coordination.
export class ConversationDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Schema init only (CLAUDE.md hard rule 9) — constructors can't be async,
    // so this is intentionally not awaited; every method still queues behind
    // `blockConcurrencyWhile` internally.
    void ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          client_id TEXT NOT NULL UNIQUE,
          sender_id TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'text',
          body TEXT,
          attachment_id TEXT,
          call_id TEXT,
          reply_to_seq INTEGER,
          deleted_at INTEGER,
          created_at INTEGER NOT NULL
        )
      `);
      ctx.storage.sql.exec(
        `CREATE INDEX IF NOT EXISTS idx_msg_created ON messages(created_at DESC)`,
      );
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS receipts (
          user_id TEXT NOT NULL PRIMARY KEY,
          delivered_seq INTEGER NOT NULL DEFAULT 0,
          read_seq INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS members_cache (
          user_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          synced_at INTEGER NOT NULL
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS typing_state (
          user_id TEXT PRIMARY KEY,
          last_broadcast_at INTEGER NOT NULL
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)
      `);
      if (ctx.id.name) this.rememberConversationId(ctx.id.name);
      return Promise.resolve();
    });
  }

  // `ctx.id.name` is only reliably populated on the instance reached via the
  // original `idFromName(...)` stub (`fetch`, or an RPC call in the same
  // request/test) — an instance the runtime reconstructs later purely from
  // the id's bytes (observed for alarm-triggered instantiation) doesn't carry
  // it. Every entry point that *does* know the id (the WS upgrade's URL, the
  // HTTP route, the `send` frame's attachment) persists it here so `alarm()`
  // — which has neither a request nor an attachment to read it from — always
  // has a durable fallback.
  private rememberConversationId(id: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES ('conversation_id', ?) ON CONFLICT(key) DO NOTHING`,
      id,
    );
  }

  private get conversationId(): string {
    if (this.ctx.id.name) return this.ctx.id.name;
    const [row] = [
      ...this.ctx.storage.sql.exec<{ value: string }>(
        `SELECT value FROM meta WHERE key = 'conversation_id'`,
      ),
    ];
    if (!row) throw new Error('ConversationDO must be addressed via idFromName(conversationId)');
    return row.value;
  }

  // ── membership cache (docs/01 §5: re-verify on connect + every write,
  // 60s TTL, invalidated by membershipChanged) ───────────────────────────
  private async isMember(userId: string, conversationId: string): Promise<boolean> {
    const [cached] = [
      ...this.ctx.storage.sql.exec<{ status: string; synced_at: number }>(
        `SELECT status, synced_at FROM members_cache WHERE user_id = ?`,
        userId,
      ),
    ];
    const now = Date.now();
    if (cached && now - cached.synced_at < MEMBERSHIP_CACHE_TTL_MS) {
      return cached.status === 'member';
    }
    const isMember = await conversationsRepo.getMembershipStatus(this.env, conversationId, userId);
    this.ctx.storage.sql.exec(
      `INSERT INTO members_cache (user_id, status, synced_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET status = excluded.status, synced_at = excluded.synced_at`,
      userId,
      isMember ? 'member' : 'removed',
      now,
    );
    return isMember;
  }

  // ── fetch: WS upgrade only ──────────────────────────────────────────────
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 });
    }
    // Set only by the Worker route after `requireAuth` + `assertConversationMember`
    // already ran (docs/01 §5) — never trust this if the DO were reachable any
    // other way, which it isn't (only via the CONVERSATION binding).
    const url = new URL(request.url);
    const userId = url.searchParams.get('actorUserId');
    // `ctx.id.name` isn't reliably populated inside this runtime (observed
    // empirically — SQLite-backed DO ids don't consistently carry it back),
    // so identity of "which conversation is this" comes from the URL the
    // Worker route built (`/api/ws/conversation/:id`), same as the frame
    // attachment below — never from `ctx.id` at all.
    const conversationId = url.pathname.split('/').pop();
    if (!userId || !conversationId) return new Response('missing actor/conversation', { status: 400 });
    if (!(await this.isMember(userId, conversationId))) {
      return new Response('not a member', { status: 403 });
    }
    this.rememberConversationId(conversationId);

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [`user:${userId}`]);
    const now = Date.now();
    server.serializeAttachment({ userId, conversationId, lastSeenAt: now } satisfies Attachment);

    this.sendFrame(server, { t: 'ready', lastSeq: this.currentLastSeq(), members: this.memberList() });

    return new Response(null, { status: 101, webSocket: client });
  }

  private currentLastSeq(): number {
    const [row] = [
      ...this.ctx.storage.sql.exec<{ seq: number | null }>(`SELECT MAX(seq) as seq FROM messages`),
    ];
    return row?.seq ?? 0;
  }

  private memberList(): { userId: string; presence: string }[] {
    return [
      ...this.ctx.storage.sql.exec<{ user_id: string }>(
        `SELECT user_id FROM members_cache WHERE status = 'member'`,
      ),
    ].map((r) => ({ userId: r.user_id, presence: 'online' }));
  }

  private sendFrame(ws: WebSocket, frame: unknown): void {
    if (ws.readyState !== WebSocket.READY_STATE_OPEN) return; // backpressure/closed: drop, don't buffer
    ws.send(JSON.stringify(frame));
  }

  private broadcast(frame: unknown, exclude?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      this.sendFrame(ws, frame);
    }
  }

  // ── hibernation handlers ────────────────────────────────────────────────
  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
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
    const result = clientFrameSchema.safeParse(parsed);
    if (!result.success) {
      this.sendFrame(ws, { t: 'error', code: 'validation/invalid', message: 'malformed frame' });
      return;
    }
    const frame = result.data;

    switch (frame.t) {
      case 'ping':
        this.sendFrame(ws, { t: 'pong' });
        return;
      case 'hello': {
        const rows = this.queryMessagesAfter(frame.lastSeq, BACKFILL_CAP);
        this.sendFrame(ws, {
          t: 'backfill',
          messages: rows.messages,
          hasMore: rows.hasMore,
        });
        return;
      }
      case 'typing': {
        const last = [
          ...this.ctx.storage.sql.exec<{ last_broadcast_at: number }>(
            `SELECT last_broadcast_at FROM typing_state WHERE user_id = ?`,
            attachment.userId,
          ),
        ][0];
        const now = Date.now();
        if (last && now - last.last_broadcast_at < TYPING_THROTTLE_MS) return;
        this.ctx.storage.sql.exec(
          `INSERT INTO typing_state (user_id, last_broadcast_at) VALUES (?, ?)
           ON CONFLICT(user_id) DO UPDATE SET last_broadcast_at = excluded.last_broadcast_at`,
          attachment.userId,
          now,
        );
        this.broadcast({ t: 'typing', userId: attachment.userId, on: frame.on }, ws);
        return;
      }
      case 'read': {
        const now = Date.now();
        this.ctx.storage.sql.exec(
          `INSERT INTO receipts (user_id, delivered_seq, read_seq, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             read_seq = MAX(receipts.read_seq, excluded.read_seq),
             delivered_seq = MAX(receipts.delivered_seq, excluded.delivered_seq),
             updated_at = excluded.updated_at`,
          attachment.userId,
          frame.seq,
          frame.seq,
          now,
        );
        this.broadcast({
          t: 'receipt',
          userId: attachment.userId,
          deliveredSeq: frame.seq,
          readSeq: frame.seq,
        });
        return;
      }
      case 'send': {
        if (!(await this.isMember(attachment.userId, attachment.conversationId))) {
          this.sendFrame(ws, {
            t: 'error',
            code: 'policy/not-found',
            message: 'not a member of this conversation',
            clientId: frame.clientId,
          });
          return;
        }
        try {
          await takeRateLimit(
            this.env,
            `conv:${attachment.conversationId}`,
            'send',
            RATE_LIMIT_PER_CONVERSATION.limit,
            RATE_LIMIT_PER_CONVERSATION.windowMs,
          );
          await takeRateLimit(
            this.env,
            `user:${attachment.userId}`,
            'send-hourly',
            RATE_LIMIT_PER_USER.limit,
            RATE_LIMIT_PER_USER.windowMs,
          );
        } catch (err) {
          const code = err instanceof AppError ? err.code : 'rate/limited';
          this.sendFrame(ws, { t: 'error', code, message: 'rate limited', clientId: frame.clientId });
          return;
        }
        await this.appendMessage({
          ...frame,
          senderId: attachment.userId,
          conversationId: attachment.conversationId,
        });
        return;
      }
    }
  }

  override webSocketClose(): void {
    // No durable state to update — `messages`/`receipts` already reflect
    // reality, and `ctx.getWebSockets()` stops returning a closed socket on
    // its own.
  }

  override webSocketError(_ws: WebSocket, error: unknown): void {
    console.error('ConversationDO websocket error', error);
  }

  // ── RPC contract (docs/03 §3) ───────────────────────────────────────────

  // Backward pagination for REST `GET /:id/messages?before=&limit=`. Returns
  // up to `limit + 1` rows (ascending) so the route can derive `hasMore`
  // without a second query.
  listMessages(before: number | null, limit: number): Message[] {
    const cappedLimit = Math.min(Math.max(limit, 1), BACKFILL_CAP);
    const rows =
      before === null
        ? [
            ...this.ctx.storage.sql.exec<MessageRow>(
              `SELECT * FROM messages ORDER BY seq DESC LIMIT ?`,
              cappedLimit + 1,
            ),
          ]
        : [
            ...this.ctx.storage.sql.exec<MessageRow>(
              `SELECT * FROM messages WHERE seq < ? ORDER BY seq DESC LIMIT ?`,
              before,
              cappedLimit + 1,
            ),
          ];
    return rows.map(rowToMessage).reverse();
  }

  private queryMessagesAfter(lastSeq: number, cap: number): { messages: Message[]; hasMore: boolean } {
    const rows = [
      ...this.ctx.storage.sql.exec<MessageRow>(
        `SELECT * FROM messages WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
        lastSeq,
        cap + 1,
      ),
    ];
    const hasMore = rows.length > cap;
    return { messages: rows.slice(0, cap).map(rowToMessage), hasMore };
  }

  // Idempotent on `clientId` (docs/03 §2.1) — the mechanism both the WS
  // `send` frame and the HTTP POST fallback funnel through, which is what
  // keeps gap-fill dedupe-safe across transports (docs/07 E2E #13). Doesn't
  // re-check membership itself: both call sites (webSocketMessage's `send`
  // case, and the `/:id/messages` route via `policy.assertCanSendMessage`)
  // already verified it immediately before calling this, and keeping it out
  // of this method avoids throwing an `AppError` across the DO↔Worker RPC
  // boundary, which doesn't reliably preserve subclass identity.
  async appendMessage(
    input: SendMessageInput & { senderId: string; conversationId?: string },
  ): Promise<Message> {
    // Optional, but every real caller supplies it (the `send` frame handler
    // has it on the attachment; the HTTP fallback route knows it from the
    // URL) — persisted here so `alarm()`'s debounced D1 preview flush always
    // has a durable conversationId to write to, without depending on
    // `ctx.id.name` (see `rememberConversationId`'s comment).
    if (input.conversationId) this.rememberConversationId(input.conversationId);

    const [existing] = [
      ...this.ctx.storage.sql.exec<MessageRow>(
        `SELECT * FROM messages WHERE client_id = ?`,
        input.clientId,
      ),
    ];
    if (existing) return rowToMessage(existing);

    const id = uuidv7();
    const now = Date.now();
    const body = input.body ? input.body.slice(0, MESSAGE_BODY_MAX_LENGTH) : null;
    const [row] = [
      ...this.ctx.storage.sql.exec<MessageRow>(
        `INSERT INTO messages (id, client_id, sender_id, kind, body, attachment_id, call_id, reply_to_seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(client_id) DO NOTHING
         RETURNING *`,
        id,
        input.clientId,
        input.senderId,
        input.kind,
        body,
        input.attachmentId ?? null,
        input.replyToSeq ?? null,
        now,
      ),
    ];

    // Lost the insert race to a concurrent duplicate `clientId` — read back
    // the winning row instead of erroring (dedupe must be race-safe, not
    // just check-then-insert).
    if (!row) {
      const [winner] = [
        ...this.ctx.storage.sql.exec<MessageRow>(
          `SELECT * FROM messages WHERE client_id = ?`,
          input.clientId,
        ),
      ];
      if (!winner) throw new Error('appendMessage: insert conflict but no winning row found');
      return rowToMessage(winner);
    }

    const message = rowToMessage(row);
    this.broadcast({ t: 'message', message });
    await this.notifyOtherMembers(this.conversationId, message, input.senderId);
    await this.ctx.storage.setAlarm(Date.now() + PREVIEW_FLUSH_DEBOUNCE_MS);
    return message;
  }

  // Fan-in to UserDO (docs/01 §5's "reach a user without knowing their
  // sockets" path) so a member's other open tabs/devices see the badge move
  // even when they have no socket open on *this* conversation (docs/09 M7
  // exit criterion), and — new in M12 — enqueues `push-queue` for whichever
  // of those members has no live socket at all (docs/03 §2.1: "After each
  // accepted `send`, the DO: broadcasts → enqueues push-queue for members
  // with no live socket"). One `hasLiveSocket` RPC decides both: a member
  // with a live socket is already seeing `broadcast`'s `message` frame, so a
  // push notification for the same message would be redundant. Best-effort
  // throughout — a member whose UserDO call or push enqueue fails doesn't
  // block message delivery, which already succeeded via `broadcast` above.
  private async notifyOtherMembers(
    conversationId: string,
    message: Message,
    senderId: string,
  ): Promise<void> {
    const others = [
      ...this.ctx.storage.sql.exec<{ user_id: string }>(
        `SELECT user_id FROM members_cache WHERE status = 'member' AND user_id != ?`,
        senderId,
      ),
    ];
    if (others.length === 0) return;

    // Read once, reused for every offline member's push title — cheaper than
    // a per-member profile lookup, and the sender is the same for all of them.
    const senderProfile = await profilesRepo
      .getProfile(this.env, { userId: senderId, sessionId: '', emailVerified: true }, senderId)
      .catch(() => undefined);
    const title = senderProfile?.displayName ?? 'New message';
    const body = previewTextFor(message.kind, message.body);

    await Promise.all(
      others.map(async (m) => {
        const stub = userStub(this.env, m.user_id);
        await stub.bumpUnread(conversationId).catch((err) => {
          console.error('UserDO.bumpUnread failed', err);
        });
        const hasLiveSocket = await stub.hasLiveSocket().catch(() => true); // fail closed: don't push on an RPC error
        if (hasLiveSocket) return;
        await enqueuePush(
          this.env,
          m.user_id,
          { type: 'message', title, body, tag: `msg-${conversationId}`, data: { url: `/c/${conversationId}` } },
          { urgency: 'normal', ttl: 60 * 60 * 24 },
        ).catch((err) => console.error('push enqueue failed', err));
      }),
    );
  }

  membershipChanged(members: MemberSnapshot[]): void {
    const now = Date.now();
    for (const m of members) {
      this.ctx.storage.sql.exec(
        `INSERT INTO members_cache (user_id, status, synced_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET status = excluded.status, synced_at = excluded.synced_at`,
        m.userId,
        m.status,
        now,
      );
      if (m.status === 'removed') {
        for (const ws of this.ctx.getWebSockets(`user:${m.userId}`)) {
          ws.close(4003, 'removed from conversation');
        }
      }
    }
  }

  stats(): { count: number; lastSeq: number } {
    const [row] = [
      ...this.ctx.storage.sql.exec<{ count: number; seq: number | null }>(
        `SELECT COUNT(*) as count, MAX(seq) as seq FROM messages`,
      ),
    ];
    return { count: row?.count ?? 0, lastSeq: row?.seq ?? 0 };
  }

  // Extensions beyond the 4-method contract, needed for the tombstone route
  // (DELETE /api/messages/:conversationId/:seq) — the route resolves the
  // sender via `getMessageBySeq`, checks `policy.assertCanEditOrDeleteMessage`
  // itself, then calls `deleteMessage`; this method trusts that already ran,
  // same rationale as `appendMessage` not re-checking membership.
  getMessageBySeq(seq: number): Message | undefined {
    const [row] = [
      ...this.ctx.storage.sql.exec<MessageRow>(`SELECT * FROM messages WHERE seq = ?`, seq),
    ];
    return row ? rowToMessage(row) : undefined;
  }

  deleteMessage(seq: number): Message | undefined {
    const now = Date.now();
    const [row] = [
      ...this.ctx.storage.sql.exec<MessageRow>(
        `UPDATE messages SET deleted_at = ?, body = NULL WHERE seq = ? RETURNING *`,
        now,
        seq,
      ),
    ];
    if (!row) return undefined;
    const message = rowToMessage(row);
    this.broadcast({ t: 'message', message });
    return message;
  }

  // Account-deletion redaction (docs/05 §9, M15). Unlike UserDO.purge(), this
  // can't wipe the whole DO — the other member's messages live here too — so
  // it tombstones only this user's own rows the same way `deleteMessage`
  // already does (body/attachment cleared, `deleted_at` set), and closes any
  // live sockets this user still has open on this conversation.
  purgeUser(userId: string): { redacted: number } {
    const now = Date.now();
    const rows = [
      ...this.ctx.storage.sql.exec<MessageRow>(
        `UPDATE messages SET deleted_at = ?, body = NULL, attachment_id = NULL
         WHERE sender_id = ? AND deleted_at IS NULL RETURNING *`,
        now,
        userId,
      ),
    ];
    for (const row of rows) this.broadcast({ t: 'message', message: rowToMessage(row) });
    for (const ws of this.ctx.getWebSockets(`user:${userId}`)) {
      ws.close(4003, 'account deleted');
    }
    return { redacted: rows.length };
  }

  // Read-only dump for `POST /api/account/export` (docs/03 §"Data"). Only
  // this user's own messages — the export is "everything about me", not a
  // full copy of a conversation the other member also owns.
  exportMessagesFor(userId: string): Message[] {
    const rows = [
      ...this.ctx.storage.sql.exec<MessageRow>(
        `SELECT * FROM messages WHERE sender_id = ? ORDER BY seq ASC`,
        userId,
      ),
    ];
    return rows.map(rowToMessage);
  }

  // ── alarm: debounced D1 preview flush + idle-socket sweep ───────────────
  // One alarm serves both jobs (CLAUDE.md/DO convention: one alarm per DO).
  // `appendMessage` calling `setAlarm` on every insert pushes any pending
  // fire forward, which is genuine debounce — and re-deriving "what to flush"
  // from SQLite (rather than carrying it in JS memory) means an eviction
  // between insert and alarm can't lose or duplicate the write.
  override async alarm(): Promise<void> {
    const stats = this.stats();
    const [meta] = [
      ...this.ctx.storage.sql.exec<{ value: string }>(
        `SELECT value FROM meta WHERE key = 'last_flushed_seq'`,
      ),
    ];
    const lastFlushedSeq = meta ? Number(meta.value) : 0;

    if (stats.lastSeq > lastFlushedSeq) {
      const [latest] = [
        ...this.ctx.storage.sql.exec<MessageRow>(`SELECT * FROM messages ORDER BY seq DESC LIMIT 1`),
      ];
      if (latest) {
        const message = rowToMessage(latest);
        await conversationsRepo.writeConversationPreview(this.env, this.conversationId, {
          lastMessageAt: message.createdAt,
          lastMessagePreview: previewTextFor(message.kind, message.body),
          lastMessageSender: message.senderId,
          lastSeq: message.seq,
        });
        this.ctx.storage.sql.exec(
          `INSERT INTO meta (key, value) VALUES ('last_flushed_seq', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          String(message.seq),
        );
      }
    }

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
