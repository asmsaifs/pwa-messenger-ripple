import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clientFrameSchema,
  serverFrameSchema,
  type ClientFrame,
  type Message,
  type ServerFrame,
} from '@shared/messages';
import { db, lastSeqMetaKey, type OutboxRow } from '../db';
import {
  enqueueOutboxMessage,
  flushOutbox,
  listOutbox,
  markOutboxSent,
  retryOutboxEntry,
  subscribeOutbox,
} from '../outbox';

// Sender id for a locally-composed message that hasn't been confirmed by the
// server yet (docs/01 §4.1 step 1: "UI renders immediately as ⏳"). Never a
// real user id, so `own` checks (`senderId !== peer.userId`) always resolve
// true for it — exactly right, since only your own sends ever sit unconfirmed
// in the outbox.
const OUTBOX_SENDER_ID = '__outbox__';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';
export type PendingStatus = 'pending' | 'sent' | 'error';

const PING_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;
const RECONNECT_ATTEMPTS_BEFORE_BANNER = 3;

function wsUrl(conversationId: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/ws/conversation/${conversationId}`;
}

export type TypingState = { userId: string; on: boolean };
export type ReceiptState = { deliveredSeq: number; readSeq: number };

// Hand-rolled WS client for the ConversationDO protocol (docs/03 §2.1, docs/04
// §4): reconnect with backoff, `hello`/backfill on (re)connect, and a
// `clientId -> status` map for optimistic-send UX. Sends and the resulting
// status now round-trip through the Dexie outbox (src/client/lib/outbox.ts,
// M8) instead of living only in memory — that's what lets a queued send
// survive a reload, and what the retry UI reads for a failed one. `messages`
// and `lastSeq` are also mirrored to Dexie (docs/02 §7) so a reopened thread
// hydrates from cache before the socket finishes connecting.
export function useConversationSocket(conversationId: string | undefined) {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState<Map<string, PendingStatus>>(new Map());
  const [typing, setTyping] = useState<TypingState | null>(null);
  const [receipts, setReceipts] = useState<Map<string, ReceiptState>>(new Map());
  const [showReconnecting, setShowReconnecting] = useState(false);
  const [outboxRows, setOutboxRows] = useState<OutboxRow[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const lastSeqRef = useRef(0);
  const attemptRef = useRef(0);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Advances the gap-fill cursor and persists it to Dexie so a reload doesn't
  // force a wider backfill than necessary (docs/02 §7: "`lastSeq` per
  // conversation drives the gap-fill handshake").
  const bumpLastSeq = useCallback(
    (seq: number) => {
      if (!conversationId || seq <= lastSeqRef.current) return;
      lastSeqRef.current = seq;
      void db.meta.put({ key: lastSeqMetaKey(conversationId), value: seq });
    },
    [conversationId],
  );

  const applyIncomingMessage = useCallback(
    (message: Message) => {
      setMessages((prev) => {
        if (prev.some((m) => m.clientId === message.clientId)) {
          return prev.map((m) => (m.clientId === message.clientId ? message : m));
        }
        return [...prev, message].sort((a, b) => a.seq - b.seq);
      });
      bumpLastSeq(message.seq);
      setPending((prev) => {
        if (!prev.has(message.clientId)) return prev;
        const next = new Map(prev);
        next.set(message.clientId, 'sent');
        return next;
      });
      if (conversationId) void db.messages.put({ ...message, conversationId });
      void markOutboxSent(message.clientId);
    },
    [bumpLastSeq, conversationId],
  );

  const send = useCallback((frame: ClientFrame) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(clientFrameSchema.parse(frame)));
  }, []);

  const handleFrame = useCallback(
    (frame: ServerFrame) => {
      switch (frame.t) {
        case 'ready':
          // `hello` must carry the *client's own* last-known seq (0 on a
          // fresh mount, or whatever it already has locally on a reconnect)
          // — not `frame.lastSeq`, which is the server's current position
          // and would make every `hello` a no-op backfill (docs/07 E2E #13).
          send({ t: 'hello', lastSeq: lastSeqRef.current });
          return;
        case 'backfill':
          setMessages((prev) => {
            const byClientId = new Map(prev.map((m) => [m.clientId, m]));
            for (const m of frame.messages) byClientId.set(m.clientId, m);
            return [...byClientId.values()].sort((a, b) => a.seq - b.seq);
          });
          for (const m of frame.messages) {
            bumpLastSeq(m.seq);
            if (conversationId) void db.messages.put({ ...m, conversationId });
            void markOutboxSent(m.clientId);
          }
          return;
        case 'message':
          applyIncomingMessage(frame.message);
          return;
        case 'typing':
          setTyping(frame.on ? { userId: frame.userId, on: true } : null);
          if (typingClearTimerRef.current) clearTimeout(typingClearTimerRef.current);
          if (frame.on) {
            typingClearTimerRef.current = setTimeout(() => setTyping(null), 5_000);
          }
          return;
        case 'receipt':
          setReceipts((prev) => {
            const next = new Map(prev);
            next.set(frame.userId, {
              deliveredSeq: frame.deliveredSeq,
              readSeq: frame.readSeq,
            });
            return next;
          });
          return;
        case 'presence':
        case 'pong':
        case 'error':
          return;
      }
    },
    [applyIncomingMessage, send, bumpLastSeq, conversationId],
  );

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      setStatus(attemptRef.current === 0 ? 'connecting' : 'reconnecting');
      const ws = new WebSocket(wsUrl(conversationId!));
      wsRef.current = ws;

      ws.addEventListener('open', () => {
        attemptRef.current = 0;
        setShowReconnecting(false);
        setStatus('open');
        pingTimerRef.current = setInterval(() => send({ t: 'ping' }), PING_INTERVAL_MS);
        // Coming back online is exactly when outbox entries queued while this
        // socket was down (or before this tab even opened) need retrying —
        // don't wait for the separate app-level flusher's next tick.
        void flushOutbox();
      });

      ws.addEventListener('message', (event) => {
        const parsed = serverFrameSchema.safeParse(JSON.parse(String(event.data)));
        if (parsed.success) handleFrame(parsed.data);
      });

      ws.addEventListener('close', () => {
        if (pingTimerRef.current) clearInterval(pingTimerRef.current);
        if (cancelled) return;
        attemptRef.current += 1;
        if (attemptRef.current >= RECONNECT_ATTEMPTS_BEFORE_BANNER)
          setShowReconnecting(true);
        setStatus('reconnecting');
        const delay = Math.min(
          RECONNECT_BASE_MS * 2 ** (attemptRef.current - 1),
          RECONNECT_MAX_MS,
        );
        reconnectTimerRef.current = setTimeout(connect, delay);
      });

      ws.addEventListener('error', () => ws.close());
    }

    // Hydrate from Dexie before opening the socket: cached messages render
    // immediately (including fully offline), and `lastSeqRef` must carry the
    // conversation's own persisted cursor *before* `hello` is sent — a fresh
    // `0` here would re-backfill everything on every reload instead of just
    // what's missing (docs/02 §7).
    void (async () => {
      const [cached, meta] = await Promise.all([
        db.messages.where('conversationId').equals(conversationId).sortBy('seq'),
        db.meta.get(lastSeqMetaKey(conversationId)),
      ]);
      if (cancelled) return;
      if (cached.length > 0) setMessages(cached);
      lastSeqRef.current = meta?.value ?? 0;
      connect();
    })();

    return () => {
      cancelled = true;
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (typingClearTimerRef.current) clearTimeout(typingClearTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
      setMessages([]);
      setPending(new Map());
      setReceipts(new Map());
      lastSeqRef.current = 0;
      attemptRef.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Composer entry point (docs/01 §4.1): write to the Dexie outbox first —
  // that's what survives a reload or a fully offline send — then take the
  // fast path over the live socket if there is one, or fall straight through
  // to the HTTP-fallback flush if not. Either way the DO's
  // `UNIQUE(client_id)` makes a duplicate impossible even if both paths race.
  const sendMessage = useCallback(
    (input: {
      clientId: string;
      kind: 'text' | 'file' | 'image' | 'voice';
      body?: string;
      attachmentId?: string;
    }) => {
      if (!conversationId) return;
      setPending((prev) => new Map(prev).set(input.clientId, 'pending'));
      void enqueueOutboxMessage({ ...input, conversationId }).then(() => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          send({ t: 'send', ...input });
        } else {
          void flushOutbox();
        }
      });
    },
    [conversationId, send],
  );

  const retryMessage = useCallback((clientId: string) => {
    void retryOutboxEntry(clientId);
  }, []);

  const sendTyping = useCallback((on: boolean) => send({ t: 'typing', on }), [send]);
  const sendRead = useCallback((seq: number) => send({ t: 'read', seq }), [send]);

  // Outbox status (`pending`/`sending` → ⏳, `failed` → retry) is the other
  // half of the tick shown in ThreadPage — a `sent` row is superseded by the
  // server echo already merged into `messages` via applyIncomingMessage, so
  // it's intentionally excluded from both `pending` and `outboxRows` below.
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    const refresh = () => {
      void listOutbox(conversationId).then((rows) => {
        if (cancelled) return;
        const unsent = rows.filter((row) => row.status !== 'sent');
        setOutboxRows(unsent);
        setPending((prev) => {
          const next = new Map(prev);
          for (const row of unsent) {
            next.set(row.clientId, row.status === 'failed' ? 'error' : 'pending');
          }
          return next;
        });
      });
    };
    refresh();
    const unsubscribe = subscribeOutbox(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [conversationId]);

  // What ThreadPage actually renders: confirmed messages plus a synthetic
  // bubble for every outbox row the server hasn't echoed back yet (docs/01
  // §4.1 — the composer must render optimistically, not wait for a round
  // trip that, offline, may not happen for a while). Once a row's `clientId`
  // shows up in `messages` (the WS echo or a gap-fill backfill), its
  // synthetic stand-in is dropped in favor of the real one.
  const messagesWithOutbox = useMemo(() => {
    const confirmedClientIds = new Set(messages.map((m) => m.clientId));
    const synthetic: Message[] = outboxRows
      .filter((row) => !confirmedClientIds.has(row.clientId))
      .map((row) => ({
        seq: Number.MAX_SAFE_INTEGER,
        id: row.clientId,
        clientId: row.clientId,
        senderId: OUTBOX_SENDER_ID,
        kind: row.kind,
        body: row.body ?? null,
        attachmentId: row.attachmentId ?? null,
        callId: null,
        replyToSeq: row.replyToSeq ?? null,
        deletedAt: null,
        createdAt: row.createdAt,
      }));
    return [...messages, ...synthetic].sort((a, b) => a.createdAt - b.createdAt);
  }, [messages, outboxRows]);

  return {
    status,
    showReconnecting,
    messages: messagesWithOutbox,
    pending,
    typing,
    receipts,
    sendMessage,
    retryMessage,
    sendTyping,
    sendRead,
  };
}
