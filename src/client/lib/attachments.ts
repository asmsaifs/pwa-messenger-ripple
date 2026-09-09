import { apiFetch, ApiError } from './api';
import { db } from './db';
import {
  attachmentUrlResponseSchema,
  completeAttachmentInputSchema,
  completeAttachmentResponseSchema,
  MAX_ATTACHMENT_BYTES,
  signAttachmentInputSchema,
  signAttachmentResponseSchema,
  type Attachment,
  type AttachmentKind,
} from '@shared/attachments';

export { MAX_ATTACHMENT_BYTES };

// docs/01 §4.2's three-step flow: sign → PUT the bytes straight to R2 (never
// through the Worker — that's the point of a presigned URL) → complete, which
// is what actually makes the attachment usable (the server only trusts its
// own sniff of the bytes, not this client's `file.type`, docs/05 §7).
export async function uploadAttachment(
  conversationId: string,
  file: File,
  kind: AttachmentKind,
  meta?: { width?: number; height?: number; durationMs?: number; waveform?: string },
): Promise<Attachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new ApiError('upload/too-large', 'That file is too large.');
  }

  const signInput = signAttachmentInputSchema.parse({
    conversationId,
    contentType: file.type || 'application/octet-stream',
    size: file.size,
    name: file.name,
    kind,
  });
  const { attachmentId, uploadUrl } = await apiFetch(
    '/api/attachments/sign',
    signAttachmentResponseSchema,
    { method: 'POST', body: signInput },
  );

  let putRes: Response;
  try {
    putRes = await fetch(uploadUrl, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Length': String(file.size) },
    });
  } catch {
    throw new ApiError('net/offline', "You're offline.");
  }
  if (!putRes.ok) {
    throw new ApiError('upload/mismatch', "That file didn't upload correctly — try again.");
  }

  const { attachment } = await apiFetch(
    `/api/attachments/${attachmentId}/complete`,
    completeAttachmentResponseSchema,
    { method: 'POST', body: completeAttachmentInputSchema.parse(meta ?? {}) },
  );
  return attachment;
}

// Fetches `presignedUrl` and drops the bytes into Dexie's `blobs` store
// (docs/02 §7) — the cache-check/cache-write half shared by
// `resolveAttachmentUrl` (which also has to fetch the presigned URL itself)
// and the voice player (which already has one from `resolveVoiceMeta`, so it
// skips a redundant `/url` round trip).
async function cacheBlobFrom(attachmentId: string, presignedUrl: string): Promise<Blob> {
  const cached = await db.blobs.get(attachmentId);
  if (cached) return cached.blob;
  const res = await fetch(presignedUrl);
  if (!res.ok) throw new ApiError('net/timeout', 'Could not download this attachment.');
  const blob = await res.blob();
  await db.blobs.put({ attachmentId, blob, mimeType: blob.type, fetchedAt: Date.now() });
  return blob;
}

// Presigned GET → blob, cached in Dexie so a reopened thread doesn't spend a
// fresh presigned URL and network fetch on every render. Returns an object
// URL — callers own revoking it. Takes just an id (not a full `Attachment`)
// because the receiving peer's message frame only ever carries
// `attachmentId` — the full row belongs to the uploader's `/complete` response.
export async function resolveAttachmentUrl(attachmentId: string): Promise<string> {
  const cached = await db.blobs.get(attachmentId);
  if (cached) return URL.createObjectURL(cached.blob);
  const { url } = await apiFetch(
    `/api/attachments/${attachmentId}/url`,
    attachmentUrlResponseSchema,
  );
  const blob = await cacheBlobFrom(attachmentId, url);
  return URL.createObjectURL(blob);
}

// Voice bubbles render their waveform immediately from stored metadata
// (docs/06 §4: "receiver renders without decoding") without fetching the
// audio bytes — those are only worth spending the network on once the peer
// actually taps play (`resolveVoicePlaybackUrl` below, reusing the presigned
// URL this returns instead of signing a second one).
export async function resolveVoiceMeta(attachmentId: string): Promise<{
  url: string;
  durationMs: number | null;
  waveform: number[] | null;
}> {
  const { url, durationMs, waveform } = await apiFetch(
    `/api/attachments/${attachmentId}/url`,
    attachmentUrlResponseSchema,
  );
  return {
    url,
    durationMs,
    waveform: waveform ? (JSON.parse(waveform) as number[]) : null,
  };
}

export async function resolveVoicePlaybackUrl(
  attachmentId: string,
  presignedUrl: string,
): Promise<string> {
  const blob = await cacheBlobFrom(attachmentId, presignedUrl);
  return URL.createObjectURL(blob);
}
