import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useConversation, useSetReadMarker } from '../lib/queries/conversations';
import { useConversationSocket } from '../lib/ws/conversationSocket';
import { uuidv7 } from '@shared/id';
import type { Message } from '@shared/messages';

const DAY_MS = 24 * 60 * 60 * 1000;
const GROUP_GAP_MS = 5 * 60 * 1000;

function dayKey(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'message'; key: string; message: Message; grouped: boolean };

function buildRows(messages: Message[]): Row[] {
  const rows: Row[] = [];
  let lastDay: number | null = null;
  let lastSenderId: string | null = null;
  let lastAt = 0;
  for (const message of messages) {
    const day = dayKey(message.createdAt);
    if (day !== lastDay) {
      rows.push({ kind: 'day', key: `day-${day}`, label: formatDay(message.createdAt) });
      lastDay = day;
      lastSenderId = null;
    }
    const grouped = message.senderId === lastSenderId && message.createdAt - lastAt < GROUP_GAP_MS;
    rows.push({ kind: 'message', key: message.clientId, message, grouped });
    lastSenderId = message.senderId;
    lastAt = message.createdAt;
  }
  return rows;
}

export function ThreadPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const { data, isPending, isError } = useConversation(conversationId);
  const { status, showReconnecting, messages, pending, typing, receipts, sendMessage, sendTyping, sendRead } =
    useConversationSocket(conversationId);
  const peerReadSeq = data ? (receipts.get(data.peer.userId)?.readSeq ?? 0) : 0;
  const setReadMarker = useSetReadMarker(conversationId ?? '');

  const [draft, setDraft] = useState('');
  const parentRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => buildRows(messages), [messages]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (rows[index]?.kind === 'day' ? 32 : 56),
    overscan: 8,
  });

  const lastSeq = messages.at(-1)?.seq;
  useEffect(() => {
    if (lastSeq !== undefined) {
      sendRead(lastSeq);
      setReadMarker.mutate({ seq: lastSeq });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSeq]);

  useEffect(() => {
    if (rows.length > 0) virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length]);

  if (!conversationId) return null;

  function handleSend() {
    const body = draft.trim();
    if (!body) return;
    sendMessage({ clientId: uuidv7(), kind: 'text', body });
    setDraft('');
    sendTyping(false);
  }

  return (
    <div className="flex h-full flex-col">
      {/* Not user-facing chrome — a hook for e2e specs to wait on the socket
          actually being open before driving frames through it. */}
      <span hidden data-testid="ws-status" data-status={status} />
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 px-4">
        <Link to="/chats" className="text-sm text-slate-500 hover:text-slate-900 lg:hidden">
          ← Back
        </Link>
        {isPending && <span className="text-sm text-slate-400">Loading…</span>}
        {isError && <span className="text-sm text-red-600">Couldn't load this conversation.</span>}
        {data && (
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{data.peer.displayName}</div>
            <div className="truncate text-xs text-slate-400" data-testid="peer-status">
              {typing?.userId === data.peer.userId ? 'typing…' : 'online'}
            </div>
          </div>
        )}
      </div>

      {showReconnecting && (
        <div className="bg-amber-50 px-4 py-1 text-center text-xs text-amber-700">Reconnecting…</div>
      )}

      <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto px-4">
        {status === 'connecting' && messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-sm text-slate-400">
            Connecting…
          </div>
        )}
        {status !== 'connecting' && messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-sm text-slate-400">
            No messages yet — say hi.
          </div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            if (row.kind === 'day') {
              return (
                <div
                  key={row.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${item.start}px)` }}
                  className="py-2 text-center text-xs text-slate-400"
                >
                  {row.label}
                </div>
              );
            }
            const message = row.message;
            const own = data ? message.senderId !== data.peer.userId : false;
            const pendingStatus = pending.get(message.clientId);
            const tick =
              pendingStatus === 'pending'
                ? '⏳'
                : pendingStatus === 'error'
                  ? '!'
                  : message.seq <= peerReadSeq
                    ? '✓✓'
                    : '✓';
            return (
              <div
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                data-testid="message-bubble"
                data-clientid={message.clientId}
                style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${item.start}px)` }}
                className={cn('flex py-0.5', own ? 'justify-end' : 'justify-start', row.grouped && 'pt-0')}
              >
                <div
                  className={cn(
                    'max-w-[75%] rounded-2xl px-3 py-2 text-sm',
                    own ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-900',
                  )}
                >
                  {message.deletedAt ? (
                    <span className="italic opacity-70">Message deleted</span>
                  ) : (
                    message.body
                  )}
                  <div
                    className={cn(
                      'mt-1 text-right text-[10px] opacity-70',
                      own && tick === '✓✓' && 'text-sky-200 opacity-100',
                    )}
                    data-testid="message-tick"
                  >
                    {formatTime(message.createdAt)}
                    {own && ` · ${tick}`}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-end gap-2 border-t border-slate-200 p-3">
        <button type="button" disabled className="text-slate-300" aria-label="Attach file (coming soon)">
          ＋
        </button>
        <button type="button" disabled className="text-slate-300" aria-label="Record voice message (coming soon)">
          🎤
        </button>
        <textarea
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            sendTyping(e.target.value.length > 0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          rows={1}
          placeholder="Message"
          data-testid="composer-input"
          className="min-h-9 flex-1 resize-none rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!draft.trim()}
          data-testid="composer-send"
          className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}
