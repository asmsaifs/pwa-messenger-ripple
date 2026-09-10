import { useEffect, useRef, useState } from 'react';
import { compressToWebp } from '../lib/media';

type Phase = 'starting' | 'live' | 'preview';

interface CapturedPhoto {
  blob: Blob;
  url: string;
  width: number;
  height: number;
}

// docs/04 §2.4: "In-app sheet: getUserMedia({video:{facingMode:'user'}})
// preview, shutter, front/back switch (hide if enumerateDevices finds < 2),
// retake/send." Docs/09 M10 exit criterion "denied-permission fallback
// works" is the parent's job (docs/04 §2.4's second sentence) — this
// component just reports the failure via `onDenied` and gets unmounted.
export function CameraCaptureSheet({
  onCapture,
  onDenied,
  onClose,
}: {
  onCapture: (file: File, width: number, height: number) => void;
  onDenied: () => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [phase, setPhase] = useState<Phase>('starting');
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [canSwitch, setCanSwitch] = useState(false);
  const [captured, setCaptured] = useState<CapturedPhoto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retakeToken, setRetakeToken] = useState(0);

  function stopStream() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  useEffect(() => {
    let cancelled = false;
    setPhase('starting');
    setError(null);
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode }, audio: false })
      .then(async (stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setPhase('live');
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          if (!cancelled) {
            setCanSwitch(devices.filter((d) => d.kind === 'videoinput').length > 1);
          }
        } catch {
          // enumerateDevices failing is harmless — switch button just stays hidden.
        }
      })
      .catch(() => {
        if (!cancelled) onDenied();
      });
    return () => {
      cancelled = true;
      stopStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facingMode, retakeToken]);

  // Every exit path (shutter, close, unmount) must stop the tracks — CLAUDE.md rule 8.
  useEffect(() => () => stopStream(), []);

  async function handleShutter() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    try {
      const { blob, width, height } = await compressToWebp(
        video,
        video.videoWidth,
        video.videoHeight,
      );
      stopStream();
      setCaptured({ blob, url: URL.createObjectURL(blob), width, height });
      setPhase('preview');
    } catch {
      setError('Could not capture that photo — try again.');
    }
  }

  function handleRetake() {
    if (captured) URL.revokeObjectURL(captured.url);
    setCaptured(null);
    setPhase('starting');
    setRetakeToken((token) => token + 1);
  }

  function handleSend() {
    if (!captured) return;
    const file = new File([captured.blob], `photo-${Date.now()}.webp`, { type: 'image/webp' });
    onCapture(file, captured.width, captured.height);
  }

  function handleClose() {
    if (captured) URL.revokeObjectURL(captured.url);
    stopStream();
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black"
      data-testid="camera-sheet"
      role="dialog"
      aria-label="Take a photo"
    >
      <div className="flex items-center justify-between p-3 text-white">
        <button type="button" onClick={handleClose} aria-label="Close camera" className="text-lg">
          ✕
        </button>
        {canSwitch && phase === 'live' && (
          <button
            type="button"
            onClick={() => setFacingMode((m) => (m === 'user' ? 'environment' : 'user'))}
            aria-label="Switch camera"
            data-testid="camera-switch"
            className="text-lg"
          >
            🔄
          </button>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        {error && (
          <div className="absolute inset-x-0 top-2 z-10 mx-auto w-fit rounded bg-red-600/90 px-3 py-1 text-xs text-white">
            {error}
          </div>
        )}
        {phase === 'preview' && captured ? (
          <img
            src={captured.url}
            alt=""
            className="h-full w-full object-contain"
            data-testid="camera-preview"
          />
        ) : (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="h-full w-full object-contain"
            data-testid="camera-video"
          />
        )}
        {phase === 'starting' && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-white/70">
            Starting camera…
          </div>
        )}
      </div>

      <div
        className="flex shrink-0 items-center justify-center gap-6 p-4"
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
      >
        {phase === 'live' && (
          <button
            type="button"
            onClick={() => void handleShutter()}
            aria-label="Take photo"
            data-testid="camera-shutter"
            className="h-16 w-16 rounded-full border-4 border-white bg-white/20"
          />
        )}
        {phase === 'preview' && (
          <>
            <button
              type="button"
              onClick={handleRetake}
              data-testid="camera-retake"
              className="rounded-lg bg-white/20 px-4 py-2 text-sm text-white"
            >
              Retake
            </button>
            <button
              type="button"
              onClick={handleSend}
              data-testid="camera-send"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white"
            >
              Send
            </button>
          </>
        )}
      </div>
    </div>
  );
}
