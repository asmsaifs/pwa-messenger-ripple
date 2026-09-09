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
