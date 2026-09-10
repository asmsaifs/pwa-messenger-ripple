import { useCallStore } from '../../store/callStore';

// docs/04 §"Incoming (in-app)": "full-screen takeover + ringtone (respect
// `prefers-reduced-motion`, mute if system DND unknowable)". There's no web
// API to read OS Do Not Disturb state, so "unknowable" means don't try —
// ring unconditionally rather than guessing. `prefers-reduced-motion` only
// gates the *visual* pulse (CallPage's own concern); it says nothing about
// audio, so it isn't checked here.
//
// Synthesized via WebAudio rather than shipping an audio asset — a classic
// two-tone ring (POTS-style 440/480 Hz) cadenced 2s-on/4s-off, looped while
// `status === 'incoming-ringing'`.

let audioCtx: AudioContext | null = null;
let cadenceTimer: ReturnType<typeof setTimeout> | null = null;
let oscillators: OscillatorNode[] = [];

function stopTone(): void {
  for (const osc of oscillators) {
    try {
      osc.stop();
    } catch {
      // already stopped
    }
  }
  oscillators = [];
}

function playTone(ctx: AudioContext): void {
  const gain = ctx.createGain();
  gain.gain.value = 0.15;
  gain.connect(ctx.destination);
  oscillators = [440, 480].map((freq) => {
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start();
    return osc;
  });
}

function ringCadence(): void {
  const ctx = audioCtx;
  if (!ctx) return;
  playTone(ctx);
  cadenceTimer = setTimeout(() => {
    stopTone();
    cadenceTimer = setTimeout(ringCadence, 4000);
  }, 2000);
}

function startRinging(): void {
  if (audioCtx) return;
  audioCtx = new AudioContext();
  ringCadence();
}

function stopRinging(): void {
  if (cadenceTimer) clearTimeout(cadenceTimer);
  cadenceTimer = null;
  stopTone();
  if (audioCtx) {
    void audioCtx.close();
    audioCtx = null;
  }
}

// Mounted once for the whole authenticated session (RequireAuth) so ringing
// isn't tied to CallPage being mounted — a push-driven Accept lands on
// CallPage already, but the in-app ring (docs/04) must start the instant
// `incoming_call` arrives over the UserDO socket, wherever the user is.
export function initRingtone(): () => void {
  return useCallStore.subscribe((state) => {
    if (state.status === 'incoming-ringing') startRinging();
    else stopRinging();
  });
}
