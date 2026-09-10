import { z } from 'zod';

export const profileSchema = z.object({
  userId: z.string(),
  displayName: z.string().min(1).max(50),
  avatarKey: z.string().nullable(),
  statusText: z.string().max(140).nullable(),
});

// GET /api/me (docs/03). `unreadTotal` comes from UserDO's per-conversation
// state (M7) — summed server-side in `UserDO.unreadTotal`, not recomputed
// from D1, so it agrees with the push-based `unread` WS frame.
export const meResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string().email(),
    emailVerified: z.boolean(),
  }),
  profile: profileSchema,
  unreadTotal: z.number().int().nonnegative(),
});

export type MeResponse = z.infer<typeof meResponseSchema>;

// PATCH /api/me (docs/03).
export const updateMeSchema = z.object({
  displayName: z.string().min(1).max(50).optional(),
  statusText: z.string().max(140).nullable().optional(),
});

export type UpdateMeInput = z.infer<typeof updateMeSchema>;

// POST /api/me/avatar/sign, /complete (docs/04 §"Settings": profile photo).
// Same sign → PUT → complete flow as attachments (docs/01 §4.2) but scoped to
// the caller's own profile row instead of a conversation.
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

export const signAvatarInputSchema = z.object({
  contentType: z.string().min(1),
  size: z.number().int().positive().max(MAX_AVATAR_BYTES),
});
export type SignAvatarInput = z.infer<typeof signAvatarInputSchema>;

export const signAvatarResponseSchema = z.object({
  uploadUrl: z.string(),
  key: z.string(),
  expiresAt: z.number().int(),
});
export type SignAvatarResponse = z.infer<typeof signAvatarResponseSchema>;

export const completeAvatarInputSchema = z.object({ key: z.string().min(1) });
export type CompleteAvatarInput = z.infer<typeof completeAvatarInputSchema>;
