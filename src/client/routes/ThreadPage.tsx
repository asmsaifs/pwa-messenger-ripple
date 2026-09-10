import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { CameraCaptureSheet } from '../components/CameraCaptureSheet';
import { VoiceRecorderSheet } from '../components/VoiceRecorderSheet';
import { VoiceMessagePlayer } from '../components/VoiceMessagePlayer';
import { resolveAttachmentUrl, uploadAttachment } from '../lib/attachments';
import { useConversation, useSetReadMarker } from '../lib/queries/conversations';
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
// blob cache only helps on a *second* view).
function AttachmentBubble({ message }: { message: Message }) {
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
          <img src={objectUrl} alt="" className="max-h-64 max-w-full rounded-lg" />
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
  const {
    status,
    showReconnecting,
    messages,
    pending,
    typing,
    receipts,
    sendMessage,
    retryMessage,
    sendTyping,
    sendRead,
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
    sendMessage({ clientId: uuidv7(), kind: 'text', body });
    setDraft('');
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
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 px-4">
        <Link
          to="/chats"
          className="text-sm text-slate-500 hover:text-slate-900 lg:hidden"
        >
          ← Back
        </Link>
        {isPending && <span className="text-sm text-slate-400">Loading…</span>}
        {isError && (
          <span className="text-sm text-red-600">Couldn't load this conversation.</span>
        )}
        {data && (
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{data.peer.displayName}</div>
            <div className="truncate text-xs text-slate-400" data-testid="peer-status">
              {typing?.userId === data.peer.userId ? 'typing…' : 'online'}
            </div>
          </div>
        )}
        {data && (
          <button
            type="button"
            data-testid="call-button"
            onClick={() => void handleStartCall()}
            disabled={!isOnline || (callStatus !== 'idle' && callStatus !== 'ended')}
            title={!isOnline ? "You're offline" : undefined}
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white disabled:cursor-not-allowed disabled:opacity-40"
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
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${item.start}px)`,
                  }}
                  className="py-2 text-center text-xs text-slate-400"
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
                  className="py-2 text-center text-xs text-slate-400"
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
                  'flex py-0.5',
                  own ? 'justify-end' : 'justify-start',
                  row.grouped && 'pt-0',
                )}
              >
                <div
                  className={cn(
                    'max-w-[75%] rounded-2xl px-3 py-2 text-sm',
                    own ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-900',
                  )}
                >
                  {message.deletedAt ? (
                    <span className="italic opacity-70">Message deleted</span>
                  ) : message.kind === 'file' || message.kind === 'image' ? (
                    <AttachmentBubble message={message} />
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
      <div className="flex items-end gap-2 border-t border-slate-200 p-3">
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
          className="text-slate-500 hover:text-slate-900 disabled:opacity-40"
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
          className="text-slate-500 hover:text-slate-900 disabled:opacity-40"
          aria-label="Take photo"
        >
          📷
        </button>
        <button
          type="button"
          onClick={() => setVoiceOpen(true)}
          disabled={uploading}
          data-testid="voice-button"
          className="text-slate-500 hover:text-slate-900 disabled:opacity-40"
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
      )}
    </div>
  );
}
