import { z } from 'zod';

export const profileSchema = z.object({
  userId: z.string(),
  displayName: z.string().min(1).max(50),
  avatarKey: z.string().nullable(),
  statusText: z.string().max(140).nullable(),
});

// GET /api/me (docs/03). `unreadTotal` isn't included yet — it's computed
// from UserDO's per-conversation state, which lands in M7; adding it here as
// a hardcoded 0 would just be a value to un-lie about later.
export const meResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string().email(),
    emailVerified: z.boolean(),
  }),
  profile: profileSchema,
});

export type MeResponse = z.infer<typeof meResponseSchema>;

// PATCH /api/me (docs/03).
export const updateMeSchema = z.object({
  displayName: z.string().min(1).max(50).optional(),
  statusText: z.string().max(140).nullable().optional(),
});

export type UpdateMeInput = z.infer<typeof updateMeSchema>;
