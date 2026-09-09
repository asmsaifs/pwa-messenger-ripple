import { z } from 'zod';

// UserDO's personal-socket protocol (docs/01 §6, docs/03 §2.2) — one socket
// per device, open for the whole session (`GET /api/ws/user`), distinct from
// ConversationDO's per-conversation socket (src/shared/messages.ts).

export const presenceStateSchema = z.enum(['online', 'away', 'offline']);
export type PresenceState = z.infer<typeof presenceStateSchema>;

export const publicProfileSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  avatarKey: z.string().nullable(),
  statusText: z.string().nullable(),
});
export type PublicProfile = z.infer<typeof publicProfileSchema>;

export const friendshipSchema = z.object({
  id: z.string(),
  userA: z.string(),
  userB: z.string(),
  requestedBy: z.string(),
  blockedBy: z.string().nullable(),
  status: z.enum(['pending', 'accepted', 'declined', 'blocked']),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Friendship = z.infer<typeof friendshipSchema>;

export const conversationPreviewSchema = z.object({
  lastMessageAt: z.number().nullable(),
  lastMessagePreview: z.string().nullable(),
  lastMessageSender: z.string().nullable(),
  lastSeq: z.number(),
});
export type ConversationPreview = z.infer<typeof conversationPreviewSchema>;

// ── client → server ─────────────────────────────────────────────────────
export const userClientFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('presence'), state: z.enum(['online', 'away']) }),
  z.object({ t: z.literal('ping') }),
]);
export type UserClientFrame = z.infer<typeof userClientFrameSchema>;

// ── server → client (docs/03 §2.2, verbatim) ───────────────────────────────
const incomingCallFrame = z.object({
  t: z.literal('incoming_call'),
  callId: z.string(),
  conversationId: z.string(),
  from: publicProfileSchema,
});
const callCancelledFrame = z.object({
  t: z.literal('call_cancelled'),
  callId: z.string(),
  reason: z.string(),
});
const friendRequestFrame = z.object({
  t: z.literal('friend_request'),
  friendship: friendshipSchema,
  from: publicProfileSchema,
});
const friendAcceptedFrame = z.object({
  t: z.literal('friend_accepted'),
  conversationId: z.string(),
  peer: publicProfileSchema,
});
const conversationUpdatedFrame = z.object({
  t: z.literal('conversation_updated'),
  conversationId: z.string(),
  preview: conversationPreviewSchema,
});

export const userServerFrameSchema = z.discriminatedUnion('t', [
  incomingCallFrame,
  callCancelledFrame,
  friendRequestFrame,
  friendAcceptedFrame,
  z.object({
    t: z.literal('unread'),
    conversationId: z.string(),
    count: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  conversationUpdatedFrame,
  z.object({
    t: z.literal('presence'),
    userId: z.string(),
    presence: presenceStateSchema,
  }),
  z.object({ t: z.literal('error'), code: z.string(), message: z.string() }),
  z.object({ t: z.literal('pong') }),
]);
export type UserServerFrame = z.infer<typeof userServerFrameSchema>;

// ── DO RPC contract (docs/03 §3) ────────────────────────────────────────
// `notify`'s input is every push-able frame except the ones that only make
// sense as a reply to the socket that's already open (`pong`) or that UserDO
// derives/persists itself rather than being told (`presence`, `error`,
// `unread` — see UserDO.bumpUnread/clearUnread, which compute the wire
// frame's count/total internally instead of trusting a caller-supplied one).
export const userEventSchema = z.discriminatedUnion('t', [
  incomingCallFrame,
  callCancelledFrame,
  friendRequestFrame,
  friendAcceptedFrame,
  conversationUpdatedFrame,
]);
export type UserEvent = z.infer<typeof userEventSchema>;
