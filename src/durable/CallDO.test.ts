import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seedFriendGraph } from '../server/repos/test-helpers';
import * as callsRepo from '../server/repos/calls';

// `idFromName`/`get`, not `getByName` (see src/server/lib/rate-limit.ts's
// comment) — the pinned local runtime doesn't implement `getByName` yet.
function stubFor(callId: string) {
  return env.CALL.get(env.CALL.idFromName(callId));
}

async function readCallRow(callId: string) {
  return env.DB.prepare(`SELECT status, started_at, ended_at, end_reason FROM calls WHERE id = ?`)
    .bind(callId)
    .first<{ status: string; started_at: number | null; ended_at: number | null; end_reason: string | null }>();
}

// Mirrors what `POST /api/calls` actually does (D1 row via the repo, then
// the DO's `create` RPC) — these tests exercise CallDO directly, not through
// the HTTP route, so they replicate that ordering by hand.
async function startCall(g: Awaited<ReturnType<typeof seedFriendGraph>>) {
  const row = await callsRepo.createCall(env, g.actorA, {
    conversationId: g.conversationId,
    calleeId: g.userB,
  });
  const stub = stubFor(row.id);
  await stub.create({ callerId: g.userA, calleeId: g.userB, conversationId: g.conversationId });
  return { callId: row.id, stub };
}

describe('CallDO', () => {
  it('rings out after 45s and writes a `missed` D1 row', async () => {
    const g = await seedFriendGraph(env);
    const { callId, stub } = await startCall(g);

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const row = await readCallRow(callId);
    expect(row?.status).toBe('missed');
    expect(row?.end_reason).toBe('timeout');
  });

  it('a second alarm fire after resolution is a no-op (idempotent)', async () => {
    const g = await seedFriendGraph(env);
    const { callId, stub } = await startCall(g);

    await runDurableObjectAlarm(stub);
    const firstEndedAt = (await readCallRow(callId))?.ended_at;

    // No alarm is scheduled anymore (`endCall` deletes it), but even a
    // direct re-fire of the handler must not clobber the terminal state.
    await runDurableObjectAlarm(stub);
    const row = await readCallRow(callId);
    expect(row?.status).toBe('missed');
    expect(row?.ended_at).toBe(firstEndedAt);
  });

  it('the callee declining writes a `declined` D1 row', async () => {
    const g = await seedFriendGraph(env);
    const { callId, stub } = await startCall(g);

    await stub.decline(g.userB, 'user');

    const row = await readCallRow(callId);
    expect(row?.status).toBe('declined');
    expect(row?.end_reason).toBe('user');
  });

  it('double-decline is a no-op (idempotent terminal transition)', async () => {
    const g = await seedFriendGraph(env);
    const { callId, stub } = await startCall(g);

    await stub.decline(g.userB, 'user');
    const firstEndedAt = (await readCallRow(callId))?.ended_at;
    await stub.decline(g.userB, 'user');

    const row = await readCallRow(callId);
    expect(row?.status).toBe('declined');
    expect(row?.ended_at).toBe(firstEndedAt);
  });

  it('the caller cancelling a ringing call writes a `missed` D1 row', async () => {
    const g = await seedFriendGraph(env);
    const { callId, stub } = await startCall(g);

    await stub.cancel(g.userA);

    const row = await readCallRow(callId);
    expect(row?.status).toBe('missed');
    expect(row?.end_reason).toBe('caller_cancelled');
  });

  it('decline only takes effect from the callee — the caller calling it is a no-op', async () => {
    const g = await seedFriendGraph(env);
    const { callId, stub } = await startCall(g);

    await stub.decline(g.userA, 'user');

    const row = await readCallRow(callId);
    expect(row?.status).toBe('ringing');
  });

  it('cancel only takes effect from the caller — the callee calling it is a no-op', async () => {
    const g = await seedFriendGraph(env);
    const { callId, stub } = await startCall(g);

    await stub.cancel(g.userB);

    const row = await readCallRow(callId);
    expect(row?.status).toBe('ringing');
  });

  it('create is idempotent — a retried route call does not reset an in-flight call', async () => {
    const g = await seedFriendGraph(env);
    const { callId, stub } = await startCall(g);
    await stub.decline(g.userB, 'user');

    // A second `create` for the same callId (e.g. a retried POST) must not
    // resurrect a resolved call back to `ringing`.
    await stub.create({ callerId: g.userA, calleeId: g.userB, conversationId: g.conversationId });

    const row = await readCallRow(callId);
    expect(row?.status).toBe('declined');
  });
});
