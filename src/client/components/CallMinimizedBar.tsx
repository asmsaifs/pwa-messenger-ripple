import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCallStore } from '../store/callStore';

function formatElapsed(startedAt: number, now: number): string {
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

// docs/04 §"Minimized": "sticky bar at top of any route ... rendered from a
// global call store so navigation never tears down the RTCPeerConnection."
// Only rendered inside AppLayout (docs/04 §1's chat/friends/settings
// routes) — `/call/:callId` itself already shows the full-screen UI, so the
// bar there would be redundant.
export function CallMinimizedBar() {
  const status = useCallStore((s) => s.status);
  const callId = useCallStore((s) => s.callId);
  const peer = useCallStore((s) => s.peer);
  const startedAt = useCallStore((s) => s.startedAt);
  const navigate = useNavigate();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (status !== 'active') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  if (status === 'idle' || status === 'ended' || !callId) return null;

  const label =
    status === 'active' && startedAt
      ? `${peer?.displayName ?? 'Call'} · ${formatElapsed(startedAt, now)}`
      : status === 'outgoing-ringing'
        ? `Calling ${peer?.displayName ?? '…'}…`
        : status === 'incoming-ringing'
          ? `Incoming call from ${peer?.displayName ?? '…'}`
          : `Connecting to ${peer?.displayName ?? '…'}…`;

  return (
    <button
      type="button"
      data-testid="call-minimized-bar"
      onClick={() => void navigate(`/call/${callId}`)}
      className="flex w-full items-center justify-center gap-2 bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
    >
      <span aria-hidden>📞</span>
      {label} · tap to return
    </button>
  );
}
