import { useEffect, useRef, useState } from 'react';
import { pickVoiceMimeType, waveformFromBlob } from '../lib/media';

type Phase = 'starting' | 'recording' | 'preview';

const MAX_MS = 5 * 60 * 1000;
const WARNING_MS = 4 * 60 * 1000 + 45 * 1000;
const LIVE_BAR_COUNT = 32;
const LIVE_FRAME_MS = 1000 / 20; // docs/06 §5: throttle canvas waveforms to 20 fps on low-end Chromebooks

interface Recorded {
  blob: Blob;
  url: string;
  durationMs: number;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// docs/04 §2.3: "Tap mic → permission → recording UI replaces composer: live
// waveform, elapsed, slide-left-to-cancel + explicit Cancel/Stop. On stop →
// preview with play/scrub, Delete, Send. Max 5 min auto-stop with warning at
// 4:45." Mirrors CameraCaptureSheet's shape (starting/live-or-recording/preview
// phases, stop every track on every exit path — CLAUDE.md rule 8 /
// docs/10's M11 note about the Chrome OS mic indicator staying lit).
export function VoiceRecorderSheet({
  onSend,
  onDenied,
  onClose,
}: {
  onSend: (file: File, durationMs: number, waveform: number[]) => void;
  onDenied: () => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('starting');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => new Array<number>(LIVE_BAR_COUNT).fill(0));
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef(0);
  const cancelledRef = useRef(false);

  function stopStream() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  function stopLiveMeter() {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    void audioCtxRef.current?.close();
    audioCtxRef.current = null;
    analyserRef.current = null;
  }

  function stopElapsedTimer() {
    if (elapsedTimerRef.current !== null) clearInterval(elapsedTimerRef.current);
    elapsedTimerRef.current = null;
  }

  function drawLiveLevels() {
    const analyser = analyserRef.current;
    if (!analyser || document.hidden) {
      rafRef.current = requestAnimationFrame(drawLiveLevels);
      return;
    }
    const now = performance.now();
    if (now - lastFrameAtRef.current >= LIVE_FRAME_MS) {
      lastFrameAtRef.current = now;
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(data);
      const step = Math.max(1, Math.floor(data.length / LIVE_BAR_COUNT));
      const next: number[] = [];
      for (let i = 0; i < LIVE_BAR_COUNT; i++) {
        const sample = data[i * step] ?? 128;
        next.push(Math.min(100, Math.round((Math.abs(sample - 128) / 128) * 100 * 2.5)));
      }
      setLevels(next);
    }
    rafRef.current = requestAnimationFrame(drawLiveLevels);
  }

  function finishRecording() {
    stopElapsedTimer();
    stopLiveMeter();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  useEffect(() => {
    let cancelled = false;
    setPhase('starting');
    setError(null);
    navigator.mediaDevices
      .getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;

        const mimeType = pickVoiceMimeType();
        const recorder = new MediaRecorder(
          stream,
          mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : { audioBitsPerSecond: 32_000 },
        );
        recorderRef.current = recorder;
        chunksRef.current = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
          stopStream();
          if (cancelledRef.current) return;
          const blob = new Blob(chunksRef.current, { type: mimeType ?? recorder.mimeType });
          const durationMs = Date.now() - startedAtRef.current;
          setRecorded({ blob, url: URL.createObjectURL(blob), durationMs });
          setPhase('preview');
        };

        const AudioCtx = window.AudioContext;
        const audioCtx = new AudioCtx();
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        audioCtx.createMediaStreamSource(stream).connect(analyser);
        audioCtxRef.current = audioCtx;
        analyserRef.current = analyser;

        startedAtRef.current = Date.now();
        recorder.start();
        setPhase('recording');
        setElapsedMs(0);
        elapsedTimerRef.current = setInterval(() => {
          const ms = Date.now() - startedAtRef.current;
          setElapsedMs(ms);
          if (ms >= MAX_MS) finishRecording();
        }, 250);
        rafRef.current = requestAnimationFrame(drawLiveLevels);
      })
      .catch(() => {
        if (!cancelled) onDenied();
      });
    return () => {
      cancelled = true;
      stopElapsedTimer();
      stopLiveMeter();
      stopStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Belt-and-suspenders on unmount for every exit path — CLAUDE.md rule 8.
  useEffect(() => () => stopStream(), []);

  function handleCancel() {
    cancelledRef.current = true;
    finishRecording();
    if (recorded) URL.revokeObjectURL(recorded.url);
    stopStream();
    onClose();
  }

  function handleStop() {
    finishRecording();
  }

  function handleDelete() {
    if (recorded) URL.revokeObjectURL(recorded.url);
    setRecorded(null);
    onClose();
  }

  async function handleSend() {
    if (!recorded) return;
    setSending(true);
    setError(null);
    try {
      const waveform = await waveformFromBlob(recorded.blob);
      const ext = recorded.blob.type.includes('ogg') ? 'ogg' : 'webm';
      const file = new File([recorded.blob], `voice-${Date.now()}.${ext}`, { type: recorded.blob.type });
      onSend(file, recorded.durationMs, waveform);
    } catch {
      setError('Could not process that recording — try again.');
      setSending(false);
    }
  }

  const showWarning = phase === 'recording' && elapsedMs >= WARNING_MS;

  return (
    <div
      className="flex items-center gap-3 border-t border-slate-200 bg-white p-3"
      data-testid="voice-recorder"
      role="dialog"
      aria-label="Record a voice message"
    >
      {error && (
        <div className="absolute inset-x-0 bottom-16 mx-auto w-fit rounded bg-red-600/90 px-3 py-1 text-xs text-white">
          {error}
        </div>
      )}

      {phase === 'starting' && <span className="text-sm text-slate-400">Starting mic…</span>}

      {phase === 'recording' && (
        <>
          <button
            type="button"
            onClick={handleCancel}
            aria-label="Cancel recording"
            data-testid="voice-cancel"
            className="text-slate-500 hover:text-slate-900"
          >
            ✕
          </button>
          <span
            className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-600"
            aria-hidden="true"
          />
          <div className="flex h-8 flex-1 items-center gap-[2px]" data-testid="voice-live-waveform">
            {levels.map((level, i) => (
              <span
                key={i}
                style={{ height: `${Math.max(8, level)}%` }}
                className="w-1 rounded-full bg-red-500"
              />
            ))}
          </div>
          <span
            className={showWarning ? 'text-sm font-medium text-amber-600' : 'text-sm text-slate-600'}
            data-testid="voice-elapsed"
          >
            {formatElapsed(elapsedMs)}
          </span>
          <button
            type="button"
            onClick={handleStop}
            aria-label="Stop recording"
            data-testid="voice-stop"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white"
          >
            Stop
          </button>
        </>
      )}

      {phase === 'preview' && recorded && (
        <>
          <audio src={recorded.url} controls className="h-9 flex-1" data-testid="voice-preview-player" />
          <span className="text-sm text-slate-500">{formatElapsed(recorded.durationMs)}</span>
          <button
            type="button"
            onClick={handleDelete}
            disabled={sending}
            aria-label="Delete recording"
            data-testid="voice-delete"
            className="text-slate-500 hover:text-slate-900 disabled:opacity-40"
          >
            🗑
          </button>
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={sending}
            data-testid="voice-send"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {sending ? '…' : 'Send'}
          </button>
        </>
      )}
    </div>
  );
}
