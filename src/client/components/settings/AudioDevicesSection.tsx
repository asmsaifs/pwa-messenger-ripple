import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import {
  getPreferredInputDeviceId,
  getPreferredOutputDeviceId,
  setPreferredInputDeviceId,
  setPreferredOutputDeviceId,
} from '../../lib/audioDevicePrefs';

const supportsSinkId =
  typeof HTMLMediaElement !== 'undefined' &&
  typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId === 'function';

// docs/04 §"Settings": "Audio devices (input/output picker + mic level meter
// + test tone)". Preference persists to localStorage
// (src/client/lib/audioDevicePrefs.ts), read by callSession.ts/CallPage.tsx
// as the default for the next call — this section previews/sets it, it
// doesn't run during a live call (CallPage has its own in-call picker for that).
export function AudioDevicesSection() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [inputId, setInputId] = useState(() => getPreferredInputDeviceId());
  const [outputId, setOutputId] = useState(() => getPreferredOutputDeviceId());
  const [level, setLevel] = useState(0);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const testAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((list) => setDevices(list.filter((d) => d.kind === 'audioinput' || d.kind === 'audiooutput')))
      .catch(() => setDevices([]));
  }, []);

  useEffect(() => {
    return () => stopListening();
  }, []);

  function stopListening() {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close();
    audioCtxRef.current = null;
    setListening(false);
    setLevel(0);
  }

  async function startListening() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: inputId ? { deviceId: { exact: inputId } } : true,
      });
      streamRef.current = stream;
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sumSquares = 0;
        for (const v of data) {
          const centered = (v - 128) / 128;
          sumSquares += centered * centered;
        }
        setLevel(Math.min(1, Math.sqrt(sumSquares / data.length) * 4));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
      setListening(true);
    } catch {
      setError("Couldn't access the microphone — check browser permission.");
    }
  }

  async function playTestTone() {
    const audioCtx = new AudioContext();
    const oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0.1;
    oscillator.frequency.value = 440;
    oscillator.connect(gain);

    if (supportsSinkId && outputId) {
      const dest = audioCtx.createMediaStreamDestination();
      gain.connect(dest);
      if (testAudioRef.current) {
        testAudioRef.current.srcObject = dest.stream;
        await (testAudioRef.current as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> })
          .setSinkId(outputId)
          .catch(() => undefined);
        void testAudioRef.current.play();
      }
    } else {
      gain.connect(audioCtx.destination);
    }
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.6);
    oscillator.onended = () => void audioCtx.close();
  }

  const inputDevices = devices.filter((d) => d.kind === 'audioinput');
  const outputDevices = devices.filter((d) => d.kind === 'audiooutput');

  return (
    <section className="rounded-card border border-border-subtle bg-surface p-4 sm:p-5">
      <h2 className="font-display text-sm font-semibold text-ink">Audio devices</h2>
      <audio ref={testAudioRef} hidden />

      <div className="mt-3 space-y-3">
        <div>
          <p className="mb-1 text-xs text-ink-muted">Microphone</p>
          <Select
            value={inputId ?? ''}
            onValueChange={(id) => {
              setInputId(id);
              setPreferredInputDeviceId(id);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="System default" />
            </SelectTrigger>
            <SelectContent>
              {inputDevices.map((d) => (
                <SelectItem key={d.deviceId} value={d.deviceId}>
                  {d.label || 'Microphone'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {supportsSinkId && (
          <div>
            <p className="mb-1 text-xs text-ink-muted">Speaker</p>
            <Select
              value={outputId ?? ''}
              onValueChange={(id) => {
                setOutputId(id);
                setPreferredOutputDeviceId(id);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="System default" />
              </SelectTrigger>
              <SelectContent>
                {outputDevices.map((d) => (
                  <SelectItem key={d.deviceId} value={d.deviceId}>
                    {d.label || 'Speaker'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => (listening ? stopListening() : void startListening())}>
            {listening ? 'Stop test' : 'Test microphone'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void playTestTone()}>
            Play test tone
          </Button>
        </div>

        {listening && (
          <div
            role="progressbar"
            aria-label="Microphone level"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(level * 100)}
            className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
          >
            <div
              className="h-full bg-emerald-500 transition-[width]"
              style={{ width: `${Math.round(level * 100)}%` }}
            />
          </div>
        )}
      </div>
    </section>
  );
}
