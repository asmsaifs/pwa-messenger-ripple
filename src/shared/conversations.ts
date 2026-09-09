import { z } from 'zod';

// GET /api/conversations row (docs/03). `unreadCount` is derivable purely
// from D1 (`lastSeq - lastReadSeq`, both already columns) — the per-row pill
// doesn't need UserDO; only the cross-conversation nav badge does (M7).
export const conversationSummarySchema = z.object({
  id: z.string(),
  peerId: z.string(),
  peerDisplayName: z.string(),
  peerAvatarKey: z.string().nullable(),
  lastMessageAt: z.number().nullable(),
  lastMessagePreview: z.string().nullable(),
  lastMessageSender: z.string().nullable(),
  lastSeq: z.number(),
  lastReadSeq: z.number(),
  unreadCount: z.number(),
  mutedUntil: z.number().nullable(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const conversationsListResponseSchema = z.object({
  conversations: z.array(conversationSummarySchema),
});
export type ConversationsListResponse = z.infer<typeof conversationsListResponseSchema>;

export const conversationDetailResponseSchema = z.object({
  conversation: conversationSummarySchema,
  peer: z.object({
    userId: z.string(),
    displayName: z.string(),
    avatarKey: z.string().nullable(),
    statusText: z.string().nullable(),
  }),
});
export type ConversationDetailResponse = z.infer<typeof conversationDetailResponseSchema>;

// POST /api/conversations/:id/read
export const setReadMarkerSchema = z.object({ seq: z.number().int().nonnegative() });
export type SetReadMarkerInput = z.infer<typeof setReadMarkerSchema>;

// POST /api/conversations/:id/mute
export const muteConversationSchema = z.object({ until: z.number().int().nullable() });
export type MuteConversationInput = z.infer<typeof muteConversationSchema>;
