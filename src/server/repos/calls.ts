import { and, eq, inArray, lt, or } from 'drizzle-orm';
import { getDb } from './db';
import { calls } from './schema';
import { uuidv7 } from '../../shared/id';
import type { Env } from '../env';
import type { Actor } from '../types';

export async function createCall(
  env: Env,
  actor: Actor,
  input: { conversationId: string; calleeId: string },
) {
  const db = getDb(env);
  const [row] = await db
    .insert(calls)
    .values({
      id: uuidv7(),
      conversationId: input.conversationId,
      callerId: actor.userId,
      calleeId: input.calleeId,
      status: 'ringing',
      createdAt: Date.now(),
    })
    .returning();
  if (!row) throw new Error('createCall: insert returned no row');
  return row;
}

// CallDO is the only writer of the final row (docs/01 §4.3); this repo
// function is what its RPC calls into, scoped to the two participants.
export async function updateCallStatus(
  env: Env,
  actor: Actor,
  callId: string,
  patch: {
    status: 'active' | 'ended' | 'missed' | 'declined' | 'failed';
    startedAt?: number;
    endedAt?: number;
    endReason?: string;
    iceRelayed?: boolean;
  },
) {
  const db = getDb(env);
  const [row] = await db
    .update(calls)
    .set({
      status: patch.status,
      startedAt: patch.startedAt,
      endedAt: patch.endedAt,
      endReason: patch.endReason,
      iceRelayed: patch.iceRelayed === undefined ? undefined : patch.iceRelayed ? 1 : 0,
    })
    .where(
      and(
        eq(calls.id, callId),
        or(eq(calls.callerId, actor.userId), eq(calls.calleeId, actor.userId)),
      ),
    )
    .returning();
  return row;
}

// "no other ringing/active call for actor" (docs/02 §5 "start call") — checked
// as the caller side; the callee side is the same query with the other id.
export async function hasOpenCall(env: Env, userId: string) {
  const db = getDb(env);
  const row = await db.query.calls.findFirst({
    where: and(
      or(eq(calls.callerId, userId), eq(calls.calleeId, userId)),
      inArray(calls.status, ['ringing', 'active']),
    ),
  });
  return row !== undefined;
}

// Non-actor: called by UserDO's `activeCall` RPC (docs/03 §3), which has no
// session/Actor at the DO layer — only the userId pinned into the WS
// attachment at connect time, same trust boundary as ConversationDO's
// `getMembershipStatus`.
export async function getOpenCall(env: Env, userId: string) {
  const db = getDb(env);
  return db.query.calls.findFirst({
    where: and(
      or(eq(calls.callerId, userId), eq(calls.calleeId, userId)),
      inArray(calls.status, ['ringing', 'active']),
    ),
  });
}

export async function getCall(env: Env, actor: Actor, id: string) {
  const db = getDb(env);
  return db.query.calls.findFirst({
    where: and(
      eq(calls.id, id),
      or(eq(calls.callerId, actor.userId), eq(calls.calleeId, actor.userId)),
    ),
  });
}

// Belt-and-braces cron sweep (docs/03 §5: "orphan `ringing` calls with no DO
// alarm; alarms are exact but DO deletion is not guaranteed") — no `Actor`
// here, this is a scheduled job, not a request.
export async function listOrphanRingingCalls(env: Env, cutoff: number) {
  const db = getDb(env);
  return db.query.calls.findMany({
    where: and(eq(calls.status, 'ringing'), lt(calls.createdAt, cutoff)),
  });
}

export async function markCallMissedDirect(env: Env, callId: string): Promise<void> {
  const db = getDb(env);
  await db
    .update(calls)
    .set({ status: 'missed', endedAt: Date.now(), endReason: 'orphaned' })
    .where(and(eq(calls.id, callId), eq(calls.status, 'ringing')));
}

export async function listCallsForConversation(
  env: Env,
  actor: Actor,
  conversationId: string,
) {
  const db = getDb(env);
  const rows = await db.query.calls.findMany({
    where: eq(calls.conversationId, conversationId),
  });
  return rows.filter((r) => r.callerId === actor.userId || r.calleeId === actor.userId);
}
