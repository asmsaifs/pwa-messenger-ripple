import { useCallback, useEffect, useRef, useState } from 'react';
import { clientFrameSchema, serverFrameSchema, type ClientFrame, type Message, type ServerFrame } from '@shared/messages';

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
// §4): reconnect with backoff, `hello`/backfill on (re)connect, and an
// in-memory `clientId -> status` map for optimistic-send UX. A full Dexie
// outbox (queued sends surviving a reload) is M8's job — this only covers a
// single tab's in-flight sends.
export function useConversationSocket(conversationId: string | undefined) {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState<Map<string, PendingStatus>>(new Map());
  const [typing, setTyping] = useState<TypingState | null>(null);
  const [receipts, setReceipts] = useState<Map<string, ReceiptState>>(new Map());
  const [showReconnecting, setShowReconnecting] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const lastSeqRef = useRef(0);
  const attemptRef = useRef(0);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyIncomingMessage = useCallback((message: Message) => {
    setMessages((prev) => {
      if (prev.some((m) => m.clientId === message.clientId)) {
        return prev.map((m) => (m.clientId === message.clientId ? message : m));
      }
      return [...prev, message].sort((a, b) => a.seq - b.seq);
    });
    lastSeqRef.current = Math.max(lastSeqRef.current, message.seq);
    setPending((prev) => {
      if (!prev.has(message.clientId)) return prev;
      const next = new Map(prev);
      next.set(message.clientId, 'sent');
      return next;
    });
  }, []);

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
          if (frame.messages.length > 0) {
            lastSeqRef.current = Math.max(
              lastSeqRef.current,
              ...frame.messages.map((m) => m.seq),
            );
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
            next.set(frame.userId, { deliveredSeq: frame.deliveredSeq, readSeq: frame.readSeq });
            return next;
          });
          return;
        case 'presence':
        case 'pong':
        case 'error':
          return;
      }
    },
    [applyIncomingMessage, send],
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
      });

      ws.addEventListener('message', (event) => {
        const parsed = serverFrameSchema.safeParse(JSON.parse(String(event.data)));
        if (parsed.success) handleFrame(parsed.data);
      });

      ws.addEventListener('close', () => {
        if (pingTimerRef.current) clearInterval(pingTimerRef.current);
        if (cancelled) return;
        attemptRef.current += 1;
        if (attemptRef.current >= RECONNECT_ATTEMPTS_BEFORE_BANNER) setShowReconnecting(true);
        setStatus('reconnecting');
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attemptRef.current - 1), RECONNECT_MAX_MS);
        reconnectTimerRef.current = setTimeout(connect, delay);
      });

      ws.addEventListener('error', () => ws.close());
    }

    connect();
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

  const sendMessage = useCallback(
    (input: { clientId: string; kind: 'text'; body: string }) => {
      setPending((prev) => new Map(prev).set(input.clientId, 'pending'));
      send({ t: 'send', ...input });
    },
    [send],
  );

  const sendTyping = useCallback((on: boolean) => send({ t: 'typing', on }), [send]);
  const sendRead = useCallback((seq: number) => send({ t: 'read', seq }), [send]);

  return {
    status,
    showReconnecting,
    messages,
    pending,
    typing,
    receipts,
    sendMessage,
    sendTyping,
    sendRead,
  };
}
