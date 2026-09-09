import { Hono } from 'hono';
import { requireAuth } from '../middleware/actor';
import { AppError } from '../errors';
import { ALLOWED_MIME_TYPES, sniffMimeType } from '../lib/magic-bytes';
import { presignGetUrl, presignPutUrl } from '../lib/r2-presign';
import * as policy from '../policy';
import * as attachmentsRepo from '../repos/attachments';
import * as profilesRepo from '../repos/profiles';
import { uuidv7 } from '../../shared/id';
import {
  attachmentSchema,
  attachmentUrlResponseSchema,
  completeAttachmentInputSchema,
  completeAttachmentResponseSchema,
  signAttachmentInputSchema,
  signAttachmentResponseSchema,
  type Attachment,
} from '../../shared/attachments';
import type { Env } from '../env';
import type { AuthUser } from '../middleware/actor';
import type { Actor } from '../types';

export const attachmentsRoute = new Hono<{
  Bindings: Env;
  Variables: { actor: Actor; authUser: AuthUser };
}>();

attachmentsRoute.use('*', requireAuth);

function toPublicAttachment(row: {
  id: string;
  conversationId: string;
  uploaderId: string;
  mimeType: string;
  byteSize: number;
  originalName: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  waveform: string | null;
  status: string;
  createdAt: number;
}): Attachment {
  return attachmentSchema.parse(row);
}

// Extension is cosmetic only (readability of the R2 key in the dashboard) —
// the trusted type comes from `/complete`'s magic-byte sniff, not this map,
// and the key itself is built from server-generated UUIDs, never the
// client's filename (docs/05 §7's path-traversal note).
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'audio/webm': 'webm',
  'video/mp4': 'mp4',
  'text/plain': 'txt',
};

attachmentsRoute.post('/sign', async (c) => {
  const actor = c.get('actor');
  const input = signAttachmentInputSchema.parse(await c.req.json());
  await policy.assertCanSignAttachmentUpload(c.env, actor, input.conversationId, input.size);

  const id = uuidv7();
  const ext = EXT_BY_CONTENT_TYPE[input.contentType] ?? 'bin';
  const key = `att/${input.conversationId}/${id}.${ext}`;

  await attachmentsRepo.createPendingAttachment(c.env, actor, {
    id,
    conversationId: input.conversationId,
    r2Key: key,
    mimeType: input.contentType,
    byteSize: input.size,
    originalName: input.name,
  });

  const { url, expiresAt } = await presignPutUrl(c.env, key, input.size);
  return c.json(
    signAttachmentResponseSchema.parse({ attachmentId: id, uploadUrl: url, key, expiresAt }),
  );
});

attachmentsRoute.post('/:id/complete', async (c) => {
  const actor = c.get('actor');
  const id = c.req.param('id');
  const meta = completeAttachmentInputSchema.parse(await c.req.json().catch(() => ({})));
  const attachment = await policy.assertCanCompleteAttachment(c.env, actor, id);

  async function fail(): Promise<never> {
    await c.env.MEDIA.delete(attachment.r2Key);
    await attachmentsRepo.markAttachmentFailed(c.env, id);
    throw new AppError('upload/mismatch');
  }

  const object = await c.env.MEDIA.head(attachment.r2Key);
  if (!object || object.size !== attachment.byteSize) return fail();

  // Sniff a small head-of-object range — every signature in magic-bytes.ts
  // fits well inside 4 KiB (docs/05 §7: "sniff magic bytes... else object
  // deleted and row `failed`" — never trust the client's declared type).
  const range = await c.env.MEDIA.get(attachment.r2Key, { range: { offset: 0, length: 4096 } });
  if (!range) return fail();
  const head = new Uint8Array(await range.arrayBuffer());
  const sniffed = sniffMimeType(head);
  if (!sniffed || !ALLOWED_MIME_TYPES.has(sniffed)) return fail();
  // The declared `mimeType` on the row came from the client at `/sign` time —
  // it must agree with what the bytes actually are, not just be "some"
  // allowed type (docs/05 §7: "consistent with the declared type"). This
  // also covers "image kind must actually be a raster image": nothing in
  // magic-bytes.ts sniffs to an `image/*` type outside `IMAGE_MIME_TYPES`.
  if (sniffed !== attachment.mimeType) return fail();

  const ready = await attachmentsRepo.markAttachmentReady(c.env, actor, id, meta);
  if (!ready) throw new AppError('policy/not-found');
  await profilesRepo.adjustStorageUsed(c.env, actor.userId, ready.byteSize);

  return c.json(completeAttachmentResponseSchema.parse({ attachment: toPublicAttachment(ready) }));
});

attachmentsRoute.get('/:id/url', async (c) => {
  const actor = c.get('actor');
  const id = c.req.param('id');
  const attachment = await policy.assertAttachmentReadable(c.env, actor, id);
  const { url, expiresAt } = await presignGetUrl(c.env, attachment.r2Key);
  return c.json(
    attachmentUrlResponseSchema.parse({
      url,
      expiresAt,
      durationMs: attachment.durationMs,
      waveform: attachment.waveform,
    }),
  );
});
