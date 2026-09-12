import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Avatar } from '../components/ui/avatar';
import { CameraCaptureSheet } from '../components/CameraCaptureSheet';
import { MediaGallery } from '../components/MediaGallery';
import { VoiceRecorderSheet } from '../components/VoiceRecorderSheet';
import { VoiceMessagePlayer } from '../components/VoiceMessagePlayer';
import { resolveAttachmentUrl, uploadAttachment } from '../lib/attachments';
import { useConversation, useSetReadMarker } from '../lib/queries/conversations';
import { useMe } from '../lib/queries/me';
import { useConversationSocket } from '../lib/ws/conversationSocket';
import { ApiError } from '../lib/api';
import { messageForErrorCode } from '../lib/errors/messages';
import { startOutgoingCall } from '../lib/webrtc/callSession';
import { useCallStore } from '../store/callStore';
import { useOnlineStatus } from '../lib/online-status';
import { uuidv7 } from '@shared/id';
import type { Message } from '@shared/messages';

// docs/07 E2E #5: "File (2 MB pdf) + image from picker → peer downloads".
// Fetches the bytes lazily (on click for a file, on mount for an image
// thumbnail) rather than eagerly for every attachment message in the list —
// each fetch spends a presigned GET + a network round trip (docs/02 §7's
// blob cache only helps on a *second* view). Images additionally open the
// full-viewport `MediaGallery` on tap (docs/04 request: "open picture and
// download ... scaled to full window view with gallery view"); non-image
// files stay download-only, no preview. The gallery is owned by ThreadPage
// (not this component) since it needs every image in the conversation, not
// just this one.
function AttachmentBubble({ message, onOpen }: { message: Message; onOpen: () => void }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const isImage = message.kind === 'image';

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    if (isImage && message.attachmentId) {
      setLoading(true);
      resolveAttachmentUrl(message.attachmentId)
        .then((url) => {
          if (cancelled) return;
          created = url;
          setObjectUrl(url);
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setError(err instanceof ApiError ? messageForErrorCode(err.code) : 'Could not load image.');
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [isImage, message.attachmentId]);

  async function handleDownload() {
    if (!message.attachmentId) return;
    setLoading(true);
    setError(null);
    try {
      const url = await resolveAttachmentUrl(message.attachmentId);
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      a.click();
    } catch (err) {
      setError(err instanceof ApiError ? messageForErrorCode(err.code) : 'Could not download this file.');
    } finally {
      setLoading(false);
    }
  }

  if (isImage) {
    return (
      <div data-testid="attachment-image">
        {objectUrl ? (
          <button
            type="button"
            onClick={onOpen}
            data-testid="attachment-image-open"
            className="block cursor-zoom-in"
            aria-label="Open image"
          >
            <img src={objectUrl} alt="" className="max-h-64 max-w-full rounded-lg" />
          </button>
        ) : (
          <div className="flex h-32 w-48 items-center justify-center rounded-lg bg-black/10 text-xs">
            {error ?? (loading ? 'Loading…' : 'Image')}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void handleDownload()}
      disabled={loading}
      data-testid="attachment-file"
      className="flex items-center gap-2 rounded-lg bg-black/10 px-3 py-2 text-left text-sm underline disabled:opacity-60"
    >
      📎 {loading ? 'Downloading…' : error ? error : 'Download file'}
    </button>
  );
}

// Shared by the reply bar's "insert into draft" row and the per-message
// React picker — docs/00-PRD.md F5a.
const QUICK_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

function quotedPreviewFor(message: Message): string {
  switch (message.kind) {
    case 'image':
      return '📎 Photo';
    case 'file':
      return '📎 File';
    case 'voice':
      return '🎤 Voice message';
    case 'call_event':
      return message.body ?? '📞 Call';
    default:
      return message.body ?? '';
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const GROUP_GAP_MS = 5 * 60 * 1000;

function dayKey(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
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
    const grouped =
      message.senderId === lastSenderId && message.createdAt - lastAt < GROUP_GAP_MS;
    rows.push({ kind: 'message', key: message.clientId, message, grouped });
    lastSenderId = message.senderId;
    lastAt = message.createdAt;
  }
  return rows;
}

export function ThreadPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const isOnline = useOnlineStatus();
  const callStatus = useCallStore((s) => s.status);
  const { data, isPending, isError } = useConversation(conversationId);
  const { data: me } = useMe();
  const {
    status,
    showReconnecting,
    messages,
    pending,
    typing,
    receipts,
    reactions,
    sendMessage,
    retryMessage,
    sendTyping,
    sendRead,
    sendReaction,
  } = useConversationSocket(conversationId);
  const peerReadSeq = data ? (receipts.get(data.peer.userId)?.readSeq ?? 0) : 0;
  const setReadMarker = useSetReadMarker(conversationId ?? '');

  const [draft, setDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraFallbackRef = useRef<HTMLInputElement>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [copiedClientId, setCopiedClientId] = useState<string | null>(null);
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null);
  const [reactPickerFor, setReactPickerFor] = useState<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // True while the viewport is pinned to the newest message — reset on
  // conversation switch, cleared once the reader scrolls away from the
  // bottom (see the scroll listener below).
  const stickToBottomRef = useRef(true);
  const rows = useMemo(() => buildRows(messages), [messages]);
  const messageBySeq = useMemo(() => {
    const map = new Map<number, Message>();
    for (const m of messages) map.set(m.seq, m);
    return map;
  }, [messages]);
  const imageMessages = useMemo(
    () => messages.filter((m) => m.kind === 'image' && !m.deletedAt),
    [messages],
  );

  async function handleCopy(message: Message) {
    try {
      await navigator.clipboard.writeText(message.body ?? quotedPreviewFor(message));
      setCopiedClientId(message.clientId);
      setTimeout(() => setCopiedClientId((id) => (id === message.clientId ? null : id)), 1500);
    } catch {
      // Clipboard permission denied or unsupported — no user-facing recovery
      // worth adding for a nice-to-have copy shortcut.
    }
  }

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

  // `virtualizer.scrollToIndex` alone isn't enough to land at the true
  // bottom: it scrolls against `estimateSize`'s flat guess, but real rows
  // (multi-line text, reply quotes, reaction pills, images) are almost
  // always taller than the estimate, so `measureElement`'s later correction
  // grows the scrollable area *after* the scroll already happened, leaving a
  // gap at the bottom. Watching the sized content div directly and re-
  // snapping via `scrollTop` (not the estimate-based API) whenever it grows
  // is what actually keeps the viewport pinned through every correction —
  // including attachment/voice thumbnails loading in asynchronously.
  useEffect(() => {
    stickToBottomRef.current = true;
  }, [conversationId]);

  useEffect(() => {
    const scrollEl = parentRef.current;
    if (!scrollEl) return;
    function onScroll() {
      if (!scrollEl) return;
      const distanceFromBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
      stickToBottomRef.current = distanceFromBottom < 80;
    }
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    return () => scrollEl.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const scrollEl = parentRef.current;
    const content = contentRef.current;
    if (!scrollEl || !content) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) scrollEl.scrollTop = scrollEl.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (rows.length === 0) return;
    if (stickToBottomRef.current) {
      virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
      // One more pass on the next frame: the row(s) just scrolled to may
      // still be at their estimated height (measureElement hasn't measured
      // them yet), so the first jump can undershoot.
      requestAnimationFrame(() => {
        const scrollEl = parentRef.current;
        if (scrollEl && stickToBottomRef.current) scrollEl.scrollTop = scrollEl.scrollHeight;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length]);

  if (!conversationId) return null;

  // docs/04 §2.5: "Call" starts an outgoing call and moves to the full-screen
  // `/call/:callId` UI once the DO/socket are actually up (docs/01 §4.3) —
  // navigating before that would land on CallPage's "not available" branch.
  async function handleStartCall() {
    if (!data || !conversationId) return;
    await startOutgoingCall(conversationId, data.peer);
    const id = useCallStore.getState().callId;
    if (id) void navigate(`/call/${id}`);
  }

  function handleSend() {
    const body = draft.trim();
    if (!body) return;
    sendMessage(
      replyTo
        ? { clientId: uuidv7(), kind: 'text', body, replyToSeq: replyTo.seq }
        : { clientId: uuidv7(), kind: 'text', body },
    );
    setDraft('');
    setReplyTo(null);
    sendTyping(false);
  }

  // docs/01 §4.2's upload flow, kicked off from the file picker: sign → PUT →
  // complete, then send a `file`/`image` message referencing the finished
  // attachment — same clientId-keyed optimistic path a text send takes
  // (docs/07 E2E #5).
  async function handleFilePicked(
    file: File,
    meta?: { width?: number; height?: number },
  ) {
    if (!conversationId) return;
    setUploadError(null);
    setUploading(true);
    try {
      const kind = file.type.startsWith('image/') ? 'image' : 'file';
      const attachment = await uploadAttachment(conversationId, file, kind, meta);
      sendMessage({ clientId: uuidv7(), kind, attachmentId: attachment.id });
    } catch (err) {
      setUploadError(err instanceof ApiError ? messageForErrorCode(err.code) : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  // docs/04 §2.4: open the in-app sheet first; if `getUserMedia` is denied
  // (or there's no camera to grant), fall back to the OS picker's own camera
  // capture UI (docs/09 M10's "denied-permission fallback works").
  function handleCameraDenied() {
    setCameraOpen(false);
    cameraFallbackRef.current?.click();
  }

  function handleCameraCapture(file: File, width: number, height: number) {
    setCameraOpen(false);
    void handleFilePicked(file, { width, height });
  }

  // docs/09 M11: mirrors handleFilePicked's sign → PUT → complete flow, but
  // the waveform is computed client-side (docs/06 §4) and travels as the
  // attachment's `durationMs`/`waveform` metadata rather than image dims.
  async function handleVoiceSend(file: File, durationMs: number, waveform: number[]) {
    setVoiceOpen(false);
    if (!conversationId) return;
    setUploadError(null);
    setUploading(true);
    try {
      const attachment = await uploadAttachment(conversationId, file, 'voice', {
        durationMs,
        waveform: JSON.stringify(waveform),
      });
      sendMessage({ clientId: uuidv7(), kind: 'voice', attachmentId: attachment.id });
    } catch (err) {
      setUploadError(err instanceof ApiError ? messageForErrorCode(err.code) : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  function handleVoiceDenied() {
    setVoiceOpen(false);
    setUploadError('Ripple needs your mic for voice messages.');
  }

  return (
    <div className="flex h-full flex-col">
      {galleryIndex !== null && galleryIndex >= 0 && (
        <MediaGallery
          images={imageMessages}
          startIndex={galleryIndex}
          onClose={() => setGalleryIndex(null)}
        />
      )}
      {cameraOpen && (
        <CameraCaptureSheet
          onCapture={handleCameraCapture}
          onDenied={handleCameraDenied}
          onClose={() => setCameraOpen(false)}
        />
      )}
      {/* Not user-facing chrome — a hook for e2e specs to wait on the socket
          actually being open before driving frames through it. */}
      <span hidden data-testid="ws-status" data-status={status} />
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border-subtle bg-surface px-3 sm:gap-3 sm:px-4">
        <Link
          to="/chats"
          className="shrink-0 text-sm text-ink-muted hover:text-ink lg:hidden"
        >
          ← Back
        </Link>
        {isPending && <span className="text-sm text-ink-muted">Loading…</span>}
        {isError && (
          <span className="text-sm text-red-600">Couldn't load this conversation.</span>
        )}
        {data && (
          <>
            <Avatar
              name={data.peer.displayName}
              avatarKey={data.peer.avatarKey}
              presence={data.conversation.peerPresence}
              size="sm"
              className="hidden sm:inline-flex"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-ink">{data.peer.displayName}</div>
              <div className="truncate text-xs text-ink-muted" data-testid="peer-status">
                {typing?.userId === data.peer.userId ? 'typing…' : data.conversation.peerPresence}
              </div>
            </div>
          </>
        )}
        {data && (
          <button
            type="button"
            data-testid="call-button"
            onClick={() => void handleStartCall()}
            disabled={!isOnline || (callStatus !== 'idle' && callStatus !== 'ended')}
            title={!isOnline ? "You're offline" : undefined}
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-500 text-white transition-colors hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Call"
          >
            📞
          </button>
        )}
      </div>

      {showReconnecting && (
        <div className="bg-amber-50 px-4 py-1 text-center text-xs text-amber-700">
          Reconnecting…
        </div>
      )}

      {uploadError && (
        <div
          className="flex items-center justify-between gap-2 bg-red-50 px-4 py-1 text-xs text-red-700"
          data-testid="upload-error"
        >
          <span>{uploadError}</span>
          <button type="button" onClick={() => setUploadError(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto bg-surface-sunken px-3 sm:px-4">
        {status === 'connecting' && messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-sm text-ink-muted">
            Connecting…
          </div>
        )}
        {status !== 'connecting' && messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-sm text-ink-muted">
            No messages yet — say hi.
          </div>
        )}
        <div ref={contentRef} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            if (row.kind === 'day') {
              return (
                <div
                  key={row.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${item.start}px)`,
                  }}
                  className="py-2 text-center text-xs text-ink-muted"
                >
                  {row.label}
                </div>
              );
            }
            const message = row.message;
            if (message.kind === 'call_event') {
              return (
                <div
                  key={row.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  data-testid="call-event"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${item.start}px)`,
                  }}
                  className="py-2 text-center text-xs text-ink-muted"
                >
                  📞 {message.body}
                </div>
              );
            }
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
            const quoted = message.replyToSeq != null ? messageBySeq.get(message.replyToSeq) : undefined;
            const messageReactions = reactions.get(message.seq) ?? [];
            const reactionGroups = new Map<string, string[]>();
            for (const r of messageReactions) {
              const list = reactionGroups.get(r.emoji) ?? [];
              list.push(r.userId);
              reactionGroups.set(r.emoji, list);
            }
            const pickerOpen = reactPickerFor === message.clientId;
            // Reply and React are separate actions (docs/00-PRD.md F5a): Reply
            // opens the composer's reply bar, React toggles a persisted pill
            // rendered under the bubble for both participants — they don't
            // share a button or a picker.
            const actions = !message.deletedAt && (
              <div className="flex shrink-0 items-start gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                {pickerOpen ? (
                  <div
                    data-testid="react-picker"
                    className="flex items-center gap-0.5 rounded-full bg-surface px-1 py-0.5 shadow-sm"
                  >
                    {QUICK_EMOJI.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        onClick={() => {
                          sendReaction(message.seq, emoji);
                          setReactPickerFor(null);
                        }}
                        data-testid="react-picker-emoji"
                        aria-label={`React ${emoji}`}
                        className="rounded-full p-0.5 text-sm hover:bg-surface-sunken"
                      >
                        {emoji}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setReactPickerFor(null)}
                      aria-label="Close"
                      className="rounded-full p-0.5 text-xs text-ink-muted hover:bg-surface-sunken"
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setReactPickerFor(message.clientId)}
                    data-testid="message-react"
                    aria-label="React"
                    className="rounded-full p-1 text-ink-muted hover:bg-surface-sunken hover:text-ink"
                  >
                    ☺
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setReplyTo(message)}
                  data-testid="message-reply"
                  aria-label="Reply"
                  className="rounded-full p-1 text-ink-muted hover:bg-surface-sunken hover:text-ink"
                >
                  ↩
                </button>
                {message.kind === 'text' && (
                  <button
                    type="button"
                    onClick={() => void handleCopy(message)}
                    data-testid="message-copy"
                    aria-label="Copy"
                    className="rounded-full p-1 text-ink-muted hover:bg-surface-sunken hover:text-ink"
                  >
                    {copiedClientId === message.clientId ? '✓' : '⧉'}
                  </button>
                )}
              </div>
            );
            return (
              <div
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                data-testid="message-bubble"
                data-clientid={message.clientId}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${item.start}px)`,
                }}
                className={cn(
                  'group flex items-end gap-1 py-0.5',
                  own ? 'justify-end' : 'justify-start',
                  row.grouped && 'pt-0',
                )}
              >
                {own && actions}
                <div className={cn('flex min-w-0 flex-col gap-0.5', own ? 'items-end' : 'items-start')}>
                  <div
                    className={cn(
                      'max-w-full rounded-2xl px-3 py-2 text-sm shadow-sm',
                      message.kind === 'voice' && 'min-w-[220px] max-w-[280px]',
                      own ? 'bg-brand-500 text-white' : 'bg-surface text-ink',
                    )}
                  >
                    {quoted && (
                      <div
                        data-testid="message-quote"
                        className={cn(
                          'mb-1 truncate rounded border-l-2 pl-2 text-xs opacity-80',
                          own ? 'border-white/50' : 'border-ink-muted',
                        )}
                      >
                        {quotedPreviewFor(quoted)}
                      </div>
                    )}
                    {message.deletedAt ? (
                      <span className="italic opacity-70">Message deleted</span>
                    ) : message.kind === 'file' || message.kind === 'image' ? (
                      <AttachmentBubble
                        message={message}
                        onOpen={() =>
                          setGalleryIndex(imageMessages.findIndex((m) => m.clientId === message.clientId))
                        }
                      />
                    ) : message.kind === 'voice' && message.attachmentId ? (
                      <VoiceMessagePlayer attachmentId={message.attachmentId} own={own} />
                    ) : (
                      message.body
                    )}
                    <div
                      className={cn(
                        'mt-1 flex items-center justify-end gap-1 text-right text-[10px] opacity-70',
                        own && tick === '✓✓' && 'text-sky-200 opacity-100',
                      )}
                      data-testid="message-tick"
                    >
                      {formatTime(message.createdAt)}
                      {own && ` · ${tick}`}
                      {own && pendingStatus === 'error' && (
                        <button
                          type="button"
                          onClick={() => retryMessage(message.clientId)}
                          data-testid="message-retry"
                          className="ml-1 underline"
                        >
                          Retry
                        </button>
                      )}
                    </div>
                  </div>
                  {/* Reaction pills render under the bubble like standard
                      messengers — a persisted, peer-visible toggle, distinct
                      from the reply bar's "insert emoji into draft" row. */}
                  {reactionGroups.size > 0 && (
                    <div className="flex flex-wrap gap-1" data-testid="message-reactions">
                      {[...reactionGroups.entries()].map(([emoji, userIds]) => {
                        const mine = !!me && userIds.includes(me.user.id);
                        return (
                          <button
                            key={emoji}
                            type="button"
                            onClick={() => sendReaction(message.seq, emoji)}
                            data-testid="message-reaction-pill"
                            className={cn(
                              'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs',
                              mine
                                ? 'border-brand-500 bg-brand-50 text-brand-700'
                                : 'border-border-subtle bg-surface text-ink-muted',
                            )}
                          >
                            <span>{emoji}</span>
                            <span>{userIds.length}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                {!own && actions}
              </div>
            );
          })}
        </div>
      </div>

      {voiceOpen ? (
        <VoiceRecorderSheet
          onSend={(file, durationMs, waveform) => void handleVoiceSend(file, durationMs, waveform)}
          onDenied={handleVoiceDenied}
          onClose={() => setVoiceOpen(false)}
        />
      ) : (
      <div className="border-t border-border-subtle bg-surface">
        {replyTo && (
          <div
            data-testid="reply-preview"
            className="flex items-center gap-2 border-b border-border-subtle px-3 py-1.5 text-xs sm:px-4"
          >
            <div className="min-w-0 flex-1 truncate border-l-2 border-brand-500 pl-2 text-ink-muted">
              Replying to {data && replyTo.senderId === data.peer.userId ? data.peer.displayName : 'yourself'}:{' '}
              {quotedPreviewFor(replyTo)}
            </div>
            <div className="flex shrink-0 gap-0.5">
              {QUICK_EMOJI.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => setDraft((d) => d + emoji)}
                  data-testid="quick-emoji"
                  className="rounded p-0.5 text-sm hover:bg-surface-sunken"
                  aria-label={`Insert ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setReplyTo(null)}
              data-testid="reply-cancel"
              aria-label="Cancel reply"
              className="shrink-0 text-ink-muted hover:text-ink"
            >
              ✕
            </button>
          </div>
        )}
      <div className="flex items-end gap-1 p-2 sm:gap-2 sm:p-3">
        <input
          ref={fileInputRef}
          type="file"
          hidden
          data-testid="attach-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void handleFilePicked(file);
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          data-testid="attach-button"
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink disabled:opacity-40 sm:size-9"
          aria-label="Attach file"
        >
          {uploading ? '…' : '＋'}
        </button>
        <input
          ref={cameraFallbackRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          data-testid="camera-fallback-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void handleFilePicked(file);
          }}
        />
        <button
          type="button"
          onClick={() => setCameraOpen(true)}
          disabled={uploading}
          data-testid="camera-button"
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink disabled:opacity-40 sm:size-9"
          aria-label="Take photo"
        >
          📷
        </button>
        <button
          type="button"
          onClick={() => setVoiceOpen(true)}
          disabled={uploading}
          data-testid="voice-button"
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink disabled:opacity-40 sm:size-9"
          aria-label="Record voice message"
        >
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
          className="min-h-9 min-w-0 flex-1 resize-none rounded-xl border border-slate-300 bg-surface px-3 py-2 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-slate-700"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!draft.trim()}
          data-testid="composer-send"
          className="shrink-0 rounded-xl bg-brand-500 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-600 disabled:opacity-40"
        >
          Send
        </button>
      </div>
      </div>
      )}
    </div>
  );
}
