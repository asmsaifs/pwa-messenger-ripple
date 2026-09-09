import { describe, expect, it } from 'vitest';
import { ALLOWED_MIME_TYPES, sniffMimeType } from './magic-bytes';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const PDF = new TextEncoder().encode('%PDF-1.4 rest of the file');
const HTML = new TextEncoder().encode('<html><body>gotcha</body></html>');
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

describe('sniffMimeType', () => {
  it('recognizes PNG magic bytes', () => {
    expect(sniffMimeType(PNG)).toBe('image/png');
  });

  it('recognizes JPEG magic bytes', () => {
    expect(sniffMimeType(JPEG)).toBe('image/jpeg');
  });

  it('recognizes a PDF header', () => {
    expect(sniffMimeType(PDF)).toBe('application/pdf');
  });

  it('SVG is never recognized, even though it is textual XML (docs/05 §7: "SVG rejected outright")', () => {
    // SVG is plain-text-shaped, so it sniffs as text/plain, not an image type
    // — the allowlist has no `image/svg+xml` sniffer at all, which is the
    // actual rejection: a `/complete` declaring image/svg+xml can never match
    // a sniffed type.
    expect(sniffMimeType(SVG)).not.toBe('image/svg+xml');
  });

  it('rejects a .png that is actually HTML (docs/07 E2E #5)', () => {
    const sniffed = sniffMimeType(HTML);
    // HTML is printable ASCII, so it sniffs as text/plain — the route's
    // mismatch check (declared image/png vs. sniffed text/plain) is what
    // actually rejects it, not `sniffMimeType` returning null.
    expect(sniffed).not.toBe('image/png');
  });

  it('unrecognized binary garbage sniffs to null', () => {
    const garbage = Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);
    expect(sniffMimeType(garbage)).toBeNull();
  });

  it('every sniffable type is in the allowlist', () => {
    expect(ALLOWED_MIME_TYPES.has('image/png')).toBe(true);
    expect(ALLOWED_MIME_TYPES.has('image/svg+xml')).toBe(false);
  });
});
