// docs/01 §4.2: "Client compresses (images → WebP ≤1600px q0.8; audio stays
// Opus)." `fitWithin` is the pure half of that (unit-testable without a real
// canvas); `compressToWebp` is the canvas-dependent half a component drives.
export const MAX_PHOTO_DIMENSION = 1600;
export const PHOTO_WEBP_QUALITY = 0.8;

export function fitWithin(
  width: number,
  height: number,
  max: number = MAX_PHOTO_DIMENSION,
): { width: number; height: number } {
  if (width <= max && height <= max) return { width, height };
  const scale = width > height ? max / width : max / height;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

// Draws `source` onto a canvas sized by `fitWithin` and encodes it as WebP.
// Takes a canvas factory so tests can stub it out (jsdom has no real canvas).
export async function compressToWebp(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  createCanvas: (w: number, h: number) => HTMLCanvasElement = (w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  },
): Promise<{ blob: Blob; width: number; height: number }> {
  const { width, height } = fitWithin(sourceWidth, sourceHeight);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  ctx.drawImage(source, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', PHOTO_WEBP_QUALITY),
  );
  if (!blob) throw new Error('WebP encode failed');
  return { blob, width, height };
}

// docs/06 §4: "Voice messages: MediaRecorder(stream, {
// mimeType:'audio/webm;codecs=opus', audioBitsPerSecond: 32000 }).
// Feature-detect; fall back to audio/ogg;codecs=opus." Null means neither is
// supported — the caller falls back to `MediaRecorder`'s own default.
export const VOICE_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus'];

export function pickVoiceMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
  return VOICE_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

export const WAVEFORM_BUCKETS = 64;

// Pure half of docs/06 §4's waveform step: "AudioContext.decodeAudioData →
// 64 RMS buckets → store smallint[]". Unit-testable without a real
// AudioContext — `waveformFromBlob` below is the impure half a component
// drives. Each bucket is 0-100 so it stores compactly as `smallint[]` JSON
// (docs/02 §1) and renders as a plain percentage-height bar.
export function rmsBuckets(samples: Float32Array, bucketCount: number = WAVEFORM_BUCKETS): number[] {
  if (samples.length === 0) return new Array(bucketCount).fill(0) as number[];
  const bucketSize = Math.max(1, Math.floor(samples.length / bucketCount));
  const buckets: number[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const start = i * bucketSize;
    const end = i === bucketCount - 1 ? samples.length : Math.min(start + bucketSize, samples.length);
    let sumSquares = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      const sample = samples[j] ?? 0;
      sumSquares += sample * sample;
      count++;
    }
    const rms = count > 0 ? Math.sqrt(sumSquares / count) : 0;
    // Speech RMS rarely approaches 1.0 — a 4x gain keeps quiet recordings
    // from rendering as a flat line, clamped so louder ones don't clip.
    buckets.push(Math.round(Math.min(1, rms * 4) * 100));
  }
  return buckets;
}

export async function waveformFromBlob(
  blob: Blob,
  decode: (arrayBuffer: ArrayBuffer) => Promise<AudioBuffer> = async (buf) => {
    const ctx = new AudioContext();
    try {
      return await ctx.decodeAudioData(buf);
    } finally {
      void ctx.close();
    }
  },
): Promise<number[]> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioBuffer = await decode(arrayBuffer);
  return rmsBuckets(audioBuffer.getChannelData(0));
}
