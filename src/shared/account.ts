import { z } from 'zod';

// GET /api/me/sessions (docs/04 §"Settings" Devices). `id` is Better Auth's
// session row id (opaque, safe to expose) — never the session `token` itself,
// which is the actual bearer credential and stays server-side.
export const sessionSummarySchema = z.object({
  id: z.string(),
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
  createdAt: z.number(),
  current: z.boolean(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const sessionsResponseSchema = z.object({
  sessions: z.array(sessionSummarySchema),
});
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;

// POST /api/account/export (docs/03 "Push & account").
export const exportAccountResponseSchema = z.object({ jobId: z.string() });
export type ExportAccountResponse = z.infer<typeof exportAccountResponseSchema>;

export const exportStatusResponseSchema = z.object({
  status: z.enum(['pending', 'ready', 'failed']),
  downloadUrl: z.string().optional(),
});
export type ExportStatusResponse = z.infer<typeof exportStatusResponseSchema>;

// DELETE /api/account (docs/03 "Push & account").
export const deleteAccountSchema = z.object({ password: z.string().min(1) });
export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;

export const deleteAccountResponseSchema = z.object({ purgeAt: z.number() });
export type DeleteAccountResponse = z.infer<typeof deleteAccountResponseSchema>;
