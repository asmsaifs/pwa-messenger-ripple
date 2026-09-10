import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  userClientFrameSchema,
  userServerFrameSchema,
  type UserClientFrame,
} from '@shared/user-events';
import type { MeResponse } from '@shared/me';
import type { ConversationsListResponse } from '@shared/conversations';
import { meQueryKey } from '../queries/me';
import { conversationsQueryKey } from '../queries/conversations';
import { handleCallCancelledFromServer, handleIncomingCall } from '../webrtc/callSession';

export type UserConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

// Same reconnect/backoff constants as useConversationSocket (docs/04 §4.2,
// verbatim) — this is the "personal socket" side of the same spec, kept in
// its own hook because it's mounted once for the whole session (docs/03
// §2.2: "one socket per device, open for the whole session"), not per-thread.
const PING_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;
const RECONNECT_ATTEMPTS_BEFORE_BANNER = 3;

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/ws/user`;
}

// Mount once at the app shell (docs/09 M7). Patches the TanStack Query caches
// that already carry unread state (`/api/me`'s `unreadTotal`, `/api/
// conversations`' per-row `unreadCount`) directly from pushed `unread`
// frames, so every open tab converges on the same numbers without each
// polling (docs/09 M7 exit criterion: "unread badge accurate across two tabs").
export function useUserSocket(enabled: boolean) {
  const [status, setStatus] = useState<UserConnectionStatus>('connecting');
  const [showReconnecting, setShowReconnecting] = useState(false);
  const queryClient = useQueryClient();

  const wsRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    function send(frame: UserClientFrame) {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(userClientFrameSchema.parse(frame)));
    }

    function applyUnread(conversationId: string, count: number, total: number) {
      queryClient.setQueryData<MeResponse>(meQueryKey, (prev) =>
        prev ? { ...prev, unreadTotal: total } : prev,
      );
      queryClient.setQueryData<ConversationsListResponse>(conversationsQueryKey, (prev) => {
        if (!prev) return prev;
        return {
          conversations: prev.conversations.map((c) =>
            c.id === conversationId ? { ...c, unreadCount: count } : c,
          ),
        };
      });
    }

    function connect() {
      if (cancelled) return;
      setStatus(attemptRef.current === 0 ? 'connecting' : 'reconnecting');
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.addEventListener('open', () => {
        attemptRef.current = 0;
        setShowReconnecting(false);
        setStatus('open');
        send({ t: 'presence', state: document.visibilityState === 'visible' ? 'online' : 'away' });
        pingTimerRef.current = setInterval(() => send({ t: 'ping' }), PING_INTERVAL_MS);
      });

      ws.addEventListener('message', (event) => {
        const parsed = userServerFrameSchema.safeParse(JSON.parse(String(event.data)));
        if (!parsed.success) return;
        const frame = parsed.data;
        switch (frame.t) {
          case 'unread':
            applyUnread(frame.conversationId, frame.count, frame.total);
            return;
          case 'friend_request':
          case 'friend_accepted':
            void queryClient.invalidateQueries({ queryKey: ['friends'] });
            if (frame.t === 'friend_accepted') {
              void queryClient.invalidateQueries({ queryKey: conversationsQueryKey });
            }
            return;
          case 'conversation_updated':
            void queryClient.invalidateQueries({ queryKey: conversationsQueryKey });
            return;
          case 'incoming_call':
            handleIncomingCall({ callId: frame.callId, conversationId: frame.conversationId, from: frame.from });
            return;
          case 'call_cancelled':
            handleCallCancelledFromServer(frame.callId, frame.reason);
            return;
          // `presence`/`pong`/`error` need no cache update.
          default:
            return;
        }
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
      wsRef.current?.close();
      wsRef.current = null;
      attemptRef.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return { status, showReconnecting };
}
