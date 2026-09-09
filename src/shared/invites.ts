import { z } from 'zod';

// GET /api/invites/:token — unauthenticated preview (docs/04 §1: works
// logged out). Deliberately minimal: only what's needed to render "X invited
// you" before the visitor has an account.
export const invitePreviewResponseSchema = z.object({ inviterName: z.string() });
export type InvitePreviewResponse = z.infer<typeof invitePreviewResponseSchema>;

// POST /api/invites/:token/claim
export const claimInvitationResponseSchema = z.object({
  friendshipId: z.string(),
  conversationId: z.string(),
});
export type ClaimInvitationResponse = z.infer<typeof claimInvitationResponseSchema>;
