import { z } from 'zod';

// ConversationDO's message shape (docs/02 §2) — rows live in DO SQLite, not
// D1, so this is the one place both the DO and the client agree on the wire
// shape (CLAUDE.md rule 5 applies to DO RPC/WS payloads the same as REST).
export const messageKindSchema = z.enum(['text', 'file', 'image', 'voice', 'call_event']);
export type MessageKind = z.infer<typeof messageKindSchema>;

export const messageSchema = z.object({
  seq: z.number().int(),
  id: z.string(),
  clientId: z.string(),
  senderId: z.string(),
  kind: messageKindSchema,
  body: z.string().nullable(),
  attachmentId: z.string().nullable(),
  callId: z.string().nullable(),
  replyToSeq: z.number().int().nullable(),
  deletedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
});
export type Message = z.infer<typeof messageSchema>;

export const MESSAGE_BODY_MAX_LENGTH = 4000;

// Shared by `POST /:id/messages` (REST fallback) and the WS `send` frame —
// both funnel into the same `ConversationDO.appendMessage` RPC (docs/01 §4,
// required for gap-fill's dedupe-across-transport guarantee, docs/07 E2E #13).
export const sendMessageInputSchema = z.object({
  clientId: z.string().min(1).max(100),
  kind: messageKindSchema,
  body: z.string().max(MESSAGE_BODY_MAX_LENGTH).optional(),
  attachmentId: z.string().optional(),
  replyToSeq: z.number().int().nonnegative().optional(),
});
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;

export const sendMessageResponseSchema = z.object({ message: messageSchema });
export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;

// docs/02 §2's `reactions` table, one row per (message, user, emoji) — a
// `react` frame toggles a single row rather than logging every tap.
export const reactionSchema = z.object({
  seq: z.number().int(),
  userId: z.string(),
  emoji: z.string().min(1).max(8),
});
export type Reaction = z.infer<typeof reactionSchema>;

export const listMessagesResponseSchema = z.object({
  messages: z.array(messageSchema),
  hasMore: z.boolean(),
  reactions: z.array(reactionSchema),
});
export type ListMessagesResponse = z.infer<typeof listMessagesResponseSchema>;

// ── WS frames (docs/03 §2.1, verbatim) ─────────────────────────────────────
export const clientFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), lastSeq: z.number().int().nonnegative() }),
  sendMessageInputSchema.extend({ t: z.literal('send') }),
  z.object({ t: z.literal('read'), seq: z.number().int().nonnegative() }),
  z.object({ t: z.literal('typing'), on: z.boolean() }),
  z.object({ t: z.literal('react'), seq: z.number().int().nonnegative(), emoji: z.string().min(1).max(8) }),
  z.object({ t: z.literal('ping') }),
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;

const memberPresenceSchema = z.object({ userId: z.string(), presence: z.string() });

export const serverFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ready'), lastSeq: z.number(), members: z.array(memberPresenceSchema) }),
  z.object({
    t: z.literal('backfill'),
    messages: z.array(messageSchema),
    hasMore: z.boolean(),
    reactions: z.array(reactionSchema),
  }),
  z.object({ t: z.literal('message'), message: messageSchema }),
  z.object({
    t: z.literal('receipt'),
    userId: z.string(),
    deliveredSeq: z.number(),
    readSeq: z.number(),
  }),
  z.object({ t: z.literal('typing'), userId: z.string(), on: z.boolean() }),
  z.object({
    t: z.literal('reaction'),
    seq: z.number().int(),
    userId: z.string(),
    emoji: z.string(),
    on: z.boolean(),
  }),
  z.object({
    t: z.literal('presence'),
    userId: z.string(),
    presence: z.enum(['online', 'away', 'offline']),
  }),
  z.object({ t: z.literal('error'), code: z.string(), message: z.string(), clientId: z.string().optional() }),
  z.object({ t: z.literal('pong') }),
]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;

// Kind-aware conversation-list preview text (docs/04 §2.1) — shared so the
// DO's D1 preview write and any client fallback render agree on the copy.
export function previewTextFor(kind: MessageKind, body: string | null): string {
  switch (kind) {
    case 'text':
      return body ?? '';
    case 'file':
      return '📎 File';
    case 'image':
      return '📎 Photo';
    case 'voice':
      return '🎤 Voice message';
    case 'call_event':
      return body ?? '📞 Call';
  }
}
