import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useCallStore } from '../store/callStore';
import {
  acceptIncomingCall,
  declineIncomingCall,
  hangUp,
  resetIdleCallState,
  setOutputDevice,
  subscribeRemoteStream,
  switchInputDevice,
  toggleMute,
} from '../lib/webrtc/callSession';
import { getPreferredOutputDeviceId } from '../lib/audioDevicePrefs';

function formatElapsed(startedAt: number, now: number): string {
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

// docs/04 §2.5/§6: full-screen call UI — outgoing/incoming/active/ended
// states, mute, device picker, network-quality chip, keyboard shortcuts.
// Renders as an overlay reached at `/call/:callId` (docs/04 §1); the actual
// `RTCPeerConnection`/socket live in callSession.ts's module singleton, not
// here, so this component can unmount (minimized) without ending the call.
export function CallPage() {
  const { callId: routeCallId } = useParams<{ callId: string }>();
  const navigate = useNavigate();
  const status = useCallStore((s) => s.status);
  const callId = useCallStore((s) => s.callId);
  const peer = useCallStore((s) => s.peer);
  const startedAt = useCallStore((s) => s.startedAt);
  const endedLabel = useCallStore((s) => s.endedLabel);
  const errorCode = useCallStore((s) => s.errorCode);
  const muted = useCallStore((s) => s.muted);
  const networkQuality = useCallStore((s) => s.networkQuality);

  const audioRef = useRef<HTMLAudioElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  // Attach the remote stream as it arrives/changes (docs/06 §"Audio focus":
  // `<audio autoplay playsinline>`).
  useEffect(
    () =>
      subscribeRemoteStream((stream) => {
        if (audioRef.current) audioRef.current.srcObject = stream;
      }),
    [],
  );

  useEffect(() => {
    if (status !== 'active') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  useEffect(() => {
    if (status !== 'active') return;
    navigator.mediaDevices
      .enumerateDevices()
      .then((list) => {
        const audioDevices = list.filter((d) => d.kind === 'audioinput' || d.kind === 'audiooutput');
        setDevices(audioDevices);
        // Settings' "Audio devices" preference (docs/04) — applied once per
        // call if the picked speaker is still present; a removed device just
        // leaves the browser default in place.
        const preferredOutput = getPreferredOutputDeviceId();
        if (
          preferredOutput &&
          audioRef.current &&
          audioDevices.some((d) => d.kind === 'audiooutput' && d.deviceId === preferredOutput)
        ) {
          void setOutputDevice(audioRef.current, preferredOutput);
        }
      })
      .catch(() => setDevices([]));
  }, [status]);

  // docs/04 §6: "Ctrl+Shift+M mute during call, Ctrl+Shift+H hang up."
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!e.ctrlKey || !e.shiftKey) return;
      if (e.key === 'M' || e.key === 'm') {
        e.preventDefault();
        toggleMute();
      } else if (e.key === 'H' || e.key === 'h') {
        e.preventDefault();
        void hangUp();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const inputDevices = devices.filter((d) => d.kind === 'audioinput');
  const outputDevices = devices.filter((d) => d.kind === 'audiooutput');
  const supportsSinkId = typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId === 'function';

  if (!routeCallId || (callId && callId !== routeCallId) || (!callId && status === 'idle')) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-slate-900 text-sm text-slate-300">
        <p>This call isn't available anymore.</p>
        <button
          type="button"
          onClick={() => void navigate('/chats')}
          className="rounded-full bg-slate-700 px-4 py-2 text-white"
        >
          Back to chats
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-between bg-slate-900 px-6 py-10 text-white">
      <audio ref={audioRef} autoPlay playsInline />
      <div aria-live="assertive" className="sr-only">
        {status === 'incoming-ringing' && `Incoming call from ${peer?.displayName ?? 'someone'}`}
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <div className="flex size-24 items-center justify-center rounded-full bg-slate-700 text-3xl font-semibold">
          {peer?.displayName?.[0]?.toUpperCase() ?? '?'}
        </div>
        <p className="text-lg font-medium">{peer?.displayName ?? 'Unknown'}</p>
        <p className="text-sm text-slate-400" role="status">
          {status === 'outgoing-ringing' && 'Calling…'}
          {status === 'incoming-ringing' && 'Incoming call'}
          {status === 'connecting' && 'Connecting…'}
          {status === 'active' && startedAt && formatElapsed(startedAt, now)}
          {status === 'ended' && endedLabel}
        </p>
        {status === 'active' && networkQuality && (
          <p
            data-testid="network-quality"
            className={
              networkQuality === 'good'
                ? 'text-xs text-emerald-400'
                : networkQuality === 'fair'
                  ? 'text-xs text-amber-400'
                  : 'text-xs text-red-400'
            }
          >
            {networkQuality === 'good' ? 'Good connection' : networkQuality === 'fair' ? 'Fair connection' : 'Poor connection'}
          </p>
        )}
        <p className="text-xs text-slate-500">Encrypted in transit</p>
      </div>

      {status === 'active' && (
        <div className="mb-6 flex flex-col items-center gap-3">
          {inputDevices.length > 0 && (
            <select
              aria-label="Microphone"
              className="rounded bg-slate-800 px-2 py-1 text-xs text-white"
              onChange={(e) => void switchInputDevice(e.target.value)}
            >
              {inputDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || 'Microphone'}
                </option>
              ))}
            </select>
          )}
          {supportsSinkId && outputDevices.length > 0 && (
            <select
              aria-label="Speaker"
              className="rounded bg-slate-800 px-2 py-1 text-xs text-white"
              onChange={(e) => {
                if (audioRef.current) void setOutputDevice(audioRef.current, e.target.value);
              }}
            >
              {outputDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || 'Speaker'}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      <div className="flex items-center gap-6">
        {status === 'incoming-ringing' && (
          <>
            <button
              type="button"
              onClick={() => void declineIncomingCall()}
              className="flex size-16 items-center justify-center rounded-full bg-red-600 text-2xl"
              aria-label="Decline"
            >
              ✕
            </button>
            <button
              type="button"
              onClick={() => void acceptIncomingCall()}
              className="flex size-16 items-center justify-center rounded-full bg-emerald-600 text-2xl"
              aria-label="Accept"
            >
              ✓
            </button>
          </>
        )}

        {(status === 'outgoing-ringing' || status === 'connecting' || status === 'active') && (
          <>
            {status === 'active' && (
              <button
                type="button"
                role="button"
                aria-pressed={muted}
                onClick={() => toggleMute()}
                className={`flex size-14 items-center justify-center rounded-full text-xl ${
                  muted ? 'bg-white text-slate-900' : 'bg-slate-700 text-white'
                }`}
                aria-label={muted ? 'Unmute' : 'Mute'}
              >
                {muted ? '🔇' : '🎙️'}
              </button>
            )}
            <button
              type="button"
              onClick={() => void hangUp()}
              className="flex size-16 items-center justify-center rounded-full bg-red-600 text-2xl"
              aria-label="End call"
            >
              ✕
            </button>
          </>
        )}

        {status === 'ended' && (
          <div className="flex flex-col items-center gap-3">
            {errorCode && (
              <button
                type="button"
                onClick={() => {
                  resetIdleCallState();
                }}
                className="rounded-full bg-slate-700 px-4 py-2 text-sm text-white"
              >
                Retry
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                resetIdleCallState();
                void navigate('/chats');
              }}
              className="rounded-full bg-slate-700 px-4 py-2 text-sm text-white"
            >
              Back to chats
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
