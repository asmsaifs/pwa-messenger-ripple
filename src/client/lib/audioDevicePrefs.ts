// Per-device preferred mic/speaker (docs/04 §"Settings" Audio devices) —
// picked in Settings, read by callSession.ts as the default `deviceId` for a
// fresh call. Never synced to the server (a per-browser preference, not
// account data) — a stale/removed device id here just falls back to the
// browser's own default via `getUserMedia`'s exact-constraint failure path,
// same as any other `NotFoundError`.
const INPUT_KEY = 'ripple-audio-input';
const OUTPUT_KEY = 'ripple-audio-output';

function read(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: string | undefined): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // best-effort — a lost preference just falls back to the browser default
  }
}

export const getPreferredInputDeviceId = () => read(INPUT_KEY);
export const setPreferredInputDeviceId = (id: string | undefined) => write(INPUT_KEY, id);
export const getPreferredOutputDeviceId = () => read(OUTPUT_KEY);
export const setPreferredOutputDeviceId = (id: string | undefined) => write(OUTPUT_KEY, id);
