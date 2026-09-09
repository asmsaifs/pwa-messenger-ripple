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
