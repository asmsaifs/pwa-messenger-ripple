// Never trust the client's `Content-Type` (docs/05 §7, CLAUDE.md hard rule
// about server-sniffed `mime_type`, docs/02 §1's schema comment). This sniffs
// the real type from the first bytes of the uploaded object and enforces an
// allowlist — SVG is rejected outright even though it's technically an image,
// because it can carry script.
type Sniffer = { mime: string; matches: (bytes: Uint8Array) => boolean };

function bytesStartWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

const SNIFFERS: Sniffer[] = [
  { mime: 'image/png', matches: (b) => bytesStartWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mime: 'image/jpeg', matches: (b) => bytesStartWith(b, [0xff, 0xd8, 0xff]) },
  { mime: 'image/gif', matches: (b) => bytesStartWith(b, [0x47, 0x49, 0x46, 0x38]) },
  {
    mime: 'image/webp',
    matches: (b) => bytesStartWith(b, [0x52, 0x49, 0x46, 0x46]) && bytesStartWith(b, [0x57, 0x45, 0x42, 0x50], 8),
  },
  { mime: 'application/pdf', matches: (b) => bytesStartWith(b, [0x25, 0x50, 0x44, 0x46]) },
  // ZIP local-file-header signature — also the container for docx/xlsx/pptx;
  // "generic zip" is a good enough allowlist entry for M9 (docs/09 scope is
  // "attachments: files", not a full office-format sniffer).
  { mime: 'application/zip', matches: (b) => bytesStartWith(b, [0x50, 0x4b, 0x03, 0x04]) },
  {
    mime: 'audio/webm',
    matches: (b) => bytesStartWith(b, [0x1a, 0x45, 0xdf, 0xa3]),
  },
  {
    mime: 'video/mp4',
    matches: (b) => bytesStartWith(b, [0x66, 0x74, 0x79, 0x70], 4),
  },
  { mime: 'text/plain', matches: (b) => isLikelyPlainText(b) },
];

// Cheap heuristic, not a real charset detector: printable ASCII/UTF-8-ish
// bytes only, no NUL — enough to distinguish "a .txt someone attached" from
// "binary garbage with a lying extension".
function isLikelyPlainText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 512));
  if (sample.length === 0) return false;
  for (const byte of sample) {
    if (byte === 0) return false;
    const printable = byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte !== 0x7f);
    if (!printable) return false;
  }
  return true;
}

// Sniffed MIME types allowed onto the platform at all (docs/05 §7: "sniff
// magic bytes... enforce an allowlist. SVG rejected outright.").
export const ALLOWED_MIME_TYPES = new Set(SNIFFERS.map((s) => s.mime));

// `head` is the first chunk of the object's bytes — callers range-GET just
// enough (a few KB is plenty for every signature above) rather than pulling
// the whole object into memory to sniff it.
export function sniffMimeType(head: Uint8Array): string | null {
  for (const sniffer of SNIFFERS) {
    if (sniffer.matches(head)) return sniffer.mime;
  }
  return null;
}
