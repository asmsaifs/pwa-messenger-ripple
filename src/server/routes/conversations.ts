import { Hono } from 'hono';
import { requireAuth } from '../middleware/actor';
import { conversationStub } from '../lib/conversation-do';
import { userStub } from '../lib/user-do';
import * as policy from '../policy';
import * as conversationsRepo from '../repos/conversations';
import * as profilesRepo from '../repos/profiles';
import {
  conversationDetailResponseSchema,
  conversationsListResponseSchema,
  muteConversationSchema,
  setReadMarkerSchema,
  type ConversationSummary,
} from '../../shared/conversations';
import { listMessagesResponseSchema, sendMessageInputSchema, sendMessageResponseSchema } from '../../shared/messages';
import type { Env } from '../env';
import type { AuthUser } from '../middleware/actor';
import type { Actor } from '../types';

export const conversationsRoute = new Hono<{
  Bindings: Env;
  Variables: { actor: Actor; authUser: AuthUser };
}>();

conversationsRoute.use('*', requireAuth);

function toSummary(row: {
  conversation: {
    id: string;
    lastMessageAt: number | null;
    lastMessagePreview: string | null;
    lastMessageSender: string | null;
    lastSeq: number;
  };
  membership: { lastReadSeq: number; mutedUntil: number | null };
  peerUserId: string;
  peerProfile?: { displayName: string; avatarKey: string | null } | undefined;
  peerPresence: 'online' | 'away' | 'offline';
}): ConversationSummary {
  return {
    id: row.conversation.id,
    peerId: row.peerUserId,
    peerDisplayName: row.peerProfile?.displayName ?? 'Unknown',
    peerAvatarKey: row.peerProfile?.avatarKey ?? null,
    peerPresence: row.peerPresence,
    lastMessageAt: row.conversation.lastMessageAt,
    lastMessagePreview: row.conversation.lastMessagePreview,
    lastMessageSender: row.conversation.lastMessageSender,
    lastSeq: row.conversation.lastSeq,
    lastReadSeq: row.membership.lastReadSeq,
    unreadCount: Math.max(0, row.conversation.lastSeq - row.membership.lastReadSeq),
    mutedUntil: row.membership.mutedUntil,
  };
}

conversationsRoute.get('/', async (c) => {
  const actor = c.get('actor');
  const rows = await conversationsRepo.listConversationsForUserWithDetails(c.env, actor);
  const presenceByPeer = new Map(
    await Promise.all(
      rows.map(async (row) => [row.peerUserId, (await userStub(c.env, row.peerUserId).presence()).state] as const),
    ),
  );
  const body = conversationsListResponseSchema.parse({
    conversations: rows.map((row) =>
      toSummary({ ...row, peerPresence: presenceByPeer.get(row.peerUserId) ?? 'offline' }),
    ),
  });
  return c.json(body);
});

conversationsRoute.get('/:id', async (c) => {
  const actor = c.get('actor');
  const id = c.req.param('id');
  const conversation = await policy.assertConversationMember(c.env, actor, id);
  const [membership, peerUserId] = await Promise.all([
    conversationsRepo.getOwnMembership(c.env, actor, id),
    conversationsRepo.getOtherMember(c.env, id, actor.userId),
  ]);
  if (!membership || !peerUserId) throw new Error('member without a membership/peer row');
  const [peerProfile, peerPresence] = await Promise.all([
    profilesRepo.getProfile(c.env, actor, peerUserId),
    userStub(c.env, peerUserId).presence(),
  ]);
  if (!peerProfile) throw new Error('conversation peer without a profile');

  const body = conversationDetailResponseSchema.parse({
    conversation: toSummary({ conversation, membership, peerUserId, peerProfile, peerPresence: peerPresence.state }),
    peer: {
      userId: peerUserId,
      displayName: peerProfile.displayName,
      avatarKey: peerProfile.avatarKey,
      statusText: peerProfile.statusText,
    },
  });
  return c.json(body);
});

conversationsRoute.get('/:id/messages', async (c) => {
  const actor = c.get('actor');
  const id = c.req.param('id');
  await policy.assertConversationMember(c.env, actor, id);

  const beforeParam = c.req.query('before');
  const before = beforeParam ? Number(beforeParam) : null;
  const limitParam = c.req.query('limit');
  const limit = limitParam ? Math.min(Number(limitParam), 500) : 50;

  // DO's `listMessages` already over-fetches by one to signal `hasMore`
  // (ascending order — the oldest row of an over-fetched page is the extra
  // one, so it's dropped from the front, not the back).
  const rows = await conversationStub(c.env, id).listMessages(before, limit);
  const hasMore = rows.length > limit;
  const body = listMessagesResponseSchema.parse({
    messages: hasMore ? rows.slice(1) : rows,
    hasMore,
  });
  return c.json(body);
});

// HTTP fallback for `send` — funnels into the same `ConversationDO.appendMessage`
// RPC as the WS frame handler, which is what keeps gap-fill dedupe-safe across
// transports (docs/07 E2E #13).
conversationsRoute.post('/:id/messages', async (c) => {
  const actor = c.get('actor');
  const id = c.req.param('id');
  await policy.assertCanSendMessage(c.env, actor, id);
  const input = sendMessageInputSchema.parse(await c.req.json());

  const message = await conversationStub(c.env, id).appendMessage({
    ...input,
    senderId: actor.userId,
    conversationId: id,
  });
  return c.json(sendMessageResponseSchema.parse({ message }));
});

conversationsRoute.post('/:id/read', async (c) => {
  const actor = c.get('actor');
  const id = c.req.param('id');
  policy.assertCanSetReadMarker();
  const { seq } = setReadMarkerSchema.parse(await c.req.json());
  await conversationsRepo.setLastReadSeq(c.env, actor, id, seq);
  // Zeroes UserDO's per-conversation count and pushes it to every open tab
  // (docs/09 M7 exit criterion: "unread badge accurate across two tabs").
  await userStub(c.env, actor.userId).clearUnread(id);
  return c.body(null, 204);
});

conversationsRoute.post('/:id/mute', async (c) => {
  const actor = c.get('actor');
  const id = c.req.param('id');
  await policy.assertConversationMember(c.env, actor, id);
  const { until } = muteConversationSchema.parse(await c.req.json());
  await conversationsRepo.setMutedUntil(c.env, actor, id, until);
  return c.body(null, 204);
});
