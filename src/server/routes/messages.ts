import { Hono } from 'hono';
import { requireAuth } from '../middleware/actor';
import { conversationStub } from '../lib/conversation-do';
import * as policy from '../policy';
import type { Env } from '../env';
import type { AuthUser } from '../middleware/actor';
import type { Actor } from '../types';

export const messagesRoute = new Hono<{
  Bindings: Env;
  Variables: { actor: Actor; authUser: AuthUser };
}>();

messagesRoute.use('*', requireAuth);

// DELETE /api/messages/:conversationId/:seq — tombstone, sender only. The
// route (not the DO) is the enforcement point: it resolves the message via
// `getMessageBySeq`, checks `assertCanEditOrDeleteMessage` against its
// `senderId`, then calls `deleteMessage` — the DO's RPC methods deliberately
// trust that ordering (see ConversationDO.ts's comment on `appendMessage`).
messagesRoute.delete('/:conversationId/:seq', async (c) => {
  const actor = c.get('actor');
  const conversationId = c.req.param('conversationId');
  const seq = Number(c.req.param('seq'));
  await policy.assertConversationMember(c.env, actor, conversationId);

  const stub = conversationStub(c.env, conversationId);
  const message = await stub.getMessageBySeq(seq);
  if (!message) return c.body(null, 404);
  policy.assertCanEditOrDeleteMessage(actor, message.senderId);

  await stub.deleteMessage(seq);
  return c.body(null, 204);
});
