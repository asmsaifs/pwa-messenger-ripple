import { z } from 'zod';

// GET /api/friends (docs/03 "Friends"). Each row already carries the other
// side's display info so the client never has to fan out to `/api/users/:id`
// just to render a list.
const friendSummarySchema = z.object({
  friendshipId: z.string(),
  userId: z.string(),
  displayName: z.string(),
  avatarKey: z.string().nullable(),
  statusText: z.string().nullable(),
});

const friendRequestSchema = z.object({
  friendshipId: z.string(),
  userId: z.string(),
  displayName: z.string(),
  avatarKey: z.string().nullable(),
  createdAt: z.number(),
});

const invitationSummarySchema = z.object({
  id: z.string(),
  email: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
});

// A blocked row only shows an "unblock" affordance to the user who set the
// block (`blockedByMe`) — the other side never sees they've been blocked
// (docs/02 §5 enumeration rule), so this list is inherently "blocked by me".
const blockedSummarySchema = z.object({
  friendshipId: z.string(),
  userId: z.string(),
  displayName: z.string(),
  avatarKey: z.string().nullable(),
});

export const friendsResponseSchema = z.object({
  friends: z.array(friendSummarySchema),
  incoming: z.array(friendRequestSchema),
  outgoing: z.array(friendRequestSchema),
  invitations: z.array(invitationSummarySchema),
  blocked: z.array(blockedSummarySchema),
});
export type FriendsResponse = z.infer<typeof friendsResponseSchema>;
export type FriendSummary = z.infer<typeof friendSummarySchema>;
export type FriendRequestSummary = z.infer<typeof friendRequestSchema>;
export type InvitationSummary = z.infer<typeof invitationSummarySchema>;
export type BlockedSummary = z.infer<typeof blockedSummarySchema>;

// POST /api/friends/invite. Single entry point for "add someone by email" —
// the server decides whether that's a friend request (already registered) or
// an email invitation (not yet), and the response `kind` tells the client
// which happened (docs/03: distinguishing kind by default; a
// `PRIVACY_STRICT_INVITES` mode that hides this is documented but not yet
// implemented — deferred, no env var reads it today).
export const inviteByEmailSchema = z.object({ email: z.string().email() });
export type InviteByEmailInput = z.infer<typeof inviteByEmailSchema>;

export const inviteByEmailResponseSchema = z.object({
  kind: z.enum(['request_sent', 'email_sent']),
});
export type InviteByEmailResponse = z.infer<typeof inviteByEmailResponseSchema>;

export const acceptFriendshipResponseSchema = z.object({ conversationId: z.string() });
export type AcceptFriendshipResponse = z.infer<typeof acceptFriendshipResponseSchema>;
