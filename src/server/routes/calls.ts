import { Hono } from 'hono';
import { requireAuth } from '../middleware/actor';
import * as policy from '../policy';
import * as callsRepo from '../repos/calls';
import * as conversationsRepo from '../repos/conversations';
import * as profilesRepo from '../repos/profiles';
import { callStub } from '../lib/call-do';
import { takeRateLimit } from '../lib/rate-limit';
import { getIceServersForUser } from '../lib/turn';
import { userStub } from '../lib/user-do';
import {
  callDetailResponseSchema,
  createCallResponseSchema,
  createCallSchema,
  listCallsResponseSchema,
  turnResponseSchema,
  type Call,
} from '../../shared/calls';
import { AppError, notFound } from '../errors';
import type { Env } from '../env';
import type { AuthUser } from '../middleware/actor';
import type { Actor } from '../types';

export const callsRoute = new Hono<{
  Bindings: Env;
  Variables: { actor: Actor; authUser: AuthUser };
}>();

// docs/05 §8: "Call spam — 1 outgoing ringing call at a time; 20/hour/user"
// (the "1 at a time" half is `policy.assertCanStartCall`'s `hasOpenCall`
// check; this is the hourly counter half).
const CALL_HOURLY_LIMIT = 20;
const ONE_HOUR_MS = 60 * 60_000;

callsRoute.use('*', requireAuth);

function toCallDto(row: {
  id: string;
  conversationId: string;
  callerId: string;
  calleeId: string;
  status: string;
  startedAt: number | null;
  endedAt: number | null;
  endReason: string | null;
  iceRelayed: number | null;
  createdAt: number;
}): Call {
  return {
    id: row.id,
    conversationId: row.conversationId,
    callerId: row.callerId,
    calleeId: row.calleeId,
    status: row.status as Call['status'],
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    endReason: row.endReason,
    iceRelayed: row.iceRelayed === null ? null : row.iceRelayed === 1,
    createdAt: row.createdAt,
  };
}

// `POST /api/calls { conversationId } → { callId, wsUrl, iceServers }`
// (docs/03 §1). `calleeId` is resolved here from conversation membership —
// never trusted as client input (policy.assertCanStartCall's comment).
callsRoute.post('/', async (c) => {
  const actor = c.get('actor');
  const input = createCallSchema.parse(await c.req.json());
  const callee = await conversationsRepo.getOtherMember(c.env, input.conversationId, actor.userId);
  if (!callee) notFound();
  await policy.assertCanStartCall(c.env, actor, input.conversationId, callee);
  await takeRateLimit(c.env, actor.userId, 'call', CALL_HOURLY_LIMIT, ONE_HOUR_MS);

  // docs/03 §2.3: "Busy: POST /api/calls returns 409 call/busy if the callee
  // has a live ringing/active call (checked via UserDO)." `hasOpenCall`
  // above (inside `assertCanStartCall`) only covers the *actor's* own open
  // call — this is the callee-side half, via the one place that can resolve
  // "which call is this user already on" without a D1 round trip. No live
  // socket at all just means "not on a call right now" (there's nothing to
  // be busy with), not an error worth failing the call over.
  const calleeActiveCall = await userStub(c.env, callee)
    .activeCall()
    .catch(() => null);
  if (calleeActiveCall) throw new AppError('call/busy');

  const row = await callsRepo.createCall(c.env, actor, {
    conversationId: input.conversationId,
    calleeId: callee,
  });
  await callStub(c.env, row.id).create({
    callId: row.id,
    callerId: actor.userId,
    calleeId: callee,
    conversationId: input.conversationId,
  });

  const { iceServers } = await getIceServersForUser(c.env, actor.userId);
  return c.json(
    createCallResponseSchema.parse({
      callId: row.id,
      wsUrl: `/api/ws/call/${row.id}`,
      iceServers,
    }),
  );
});

// `POST /api/calls/:id/decline → 204` (docs/03 §1) — the callee declining
// without (or before) opening the CallDO WS, e.g. a push notification's
// Decline action.
callsRoute.post('/:id/decline', async (c) => {
  const actor = c.get('actor');
  const id = c.req.param('id');
  const call = await policy.assertCanActOnCall(c.env, actor, id);
  if (actor.userId !== call.calleeId) return c.body(null, 204); // only the callee can decline; a no-op for the caller keeps this endpoint enumeration-safe
  await callStub(c.env, id).decline(actor.userId, 'user');
  return c.body(null, 204);
});

// `GET /api/calls/:id → { call, peer, direction }` — cold-start hydration
// for a client with no WS-populated call store yet (docs/03 §2.3 addendum):
// a PWA launched fresh from a push notification's Accept action never saw
// the `incoming_call` UserDO frame the ringing screen normally comes from,
// so `CallPage` has to be able to ask "what's the state of this call?"
// directly instead of only ever being told. D1's `calls` row (not CallDO) is
// the source here — the same shape callSweep./history already read, so a
// terminal state written by an alarm or the sweep shows up here too.
callsRoute.get('/:id', async (c) => {
  const actor = c.get('actor');
  const id = c.req.param('id');
  const call = await policy.assertCanActOnCall(c.env, actor, id);
  const direction = actor.userId === call.callerId ? 'caller' : 'callee';
  const peerId = direction === 'caller' ? call.calleeId : call.callerId;
  const peerProfile = await profilesRepo.getProfile(c.env, actor, peerId);
  return c.json(
    callDetailResponseSchema.parse({
      call: toCallDto(call),
      peer: {
        userId: peerId,
        displayName: peerProfile?.displayName ?? 'Someone',
        avatarKey: peerProfile?.avatarKey ?? null,
        statusText: peerProfile?.statusText ?? null,
      },
      direction,
    }),
  );
});

// `GET /api/calls?conversationId= → history page` (docs/03 §1).
callsRoute.get('/', async (c) => {
  const actor = c.get('actor');
  const conversationId = c.req.query('conversationId');
  if (!conversationId) return c.json(listCallsResponseSchema.parse({ calls: [] }));
  await policy.assertConversationMember(c.env, actor, conversationId);
  const rows = await callsRepo.listCallsForConversation(c.env, actor, conversationId);
  return c.json(listCallsResponseSchema.parse({ calls: rows.map(toCallDto) }));
});

// `GET /api/turn → { iceServers, ttlSeconds }` (docs/03 §1) — its own route
// (not nested under `/api/calls`, per the exact contract path), mounted
// separately in index.ts but defined here since it shares this file's
// TURN/rate-limit imports.
export const turnRoute = new Hono<{
  Bindings: Env;
  Variables: { actor: Actor; authUser: AuthUser };
}>();
turnRoute.use('*', requireAuth);
turnRoute.get('/', async (c) => {
  const actor = c.get('actor');
  await takeRateLimit(c.env, actor.userId, 'turn', 60, ONE_HOUR_MS);
  const result = await getIceServersForUser(c.env, actor.userId);
  return c.json(turnResponseSchema.parse(result));
});
