import { z } from 'zod';

// docs/03 "Attachments" — every request/response shape here is imported by
// both the route and the client (CLAUDE.md rule 5).
export const attachmentKindSchema = z.enum(['file', 'image', 'voice']);
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;

// 25 MiB (docs/02 §1's `chk_att_size` CHECK, docs/05 §7's "25 MiB" quota
// language) — kept here too so the client can reject an oversize pick before
// spending a round trip on `/sign`.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const signAttachmentInputSchema = z.object({
  conversationId: z.string().min(1),
  contentType: z.string().min(1),
  size: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
  name: z.string().min(1).max(255),
  kind: attachmentKindSchema,
});
export type SignAttachmentInput = z.infer<typeof signAttachmentInputSchema>;

export const signAttachmentResponseSchema = z.object({
  attachmentId: z.string(),
  uploadUrl: z.string(),
  key: z.string(),
  expiresAt: z.number().int(),
});
export type SignAttachmentResponse = z.infer<typeof signAttachmentResponseSchema>;

export const completeAttachmentInputSchema = z.object({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().positive().optional(),
  waveform: z.string().optional(),
});
export type CompleteAttachmentInput = z.infer<typeof completeAttachmentInputSchema>;

// Client-facing attachment shape — deliberately excludes `r2Key` (docs/05 §7:
// keys are server-constructed from validated UUIDs and never exposed; the
// client gets bytes via a presigned GET from `/url`, never the raw key).
export const attachmentSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  uploaderId: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int(),
  originalName: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  waveform: z.string().nullable(),
  status: z.enum(['pending', 'ready', 'failed', 'deleted']),
  createdAt: z.number().int(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const completeAttachmentResponseSchema = z.object({ attachment: attachmentSchema });
export type CompleteAttachmentResponse = z.infer<typeof completeAttachmentResponseSchema>;

export const attachmentUrlResponseSchema = z.object({
  url: z.string(),
  expiresAt: z.number().int(),
});
export type AttachmentUrlResponse = z.infer<typeof attachmentUrlResponseSchema>;
