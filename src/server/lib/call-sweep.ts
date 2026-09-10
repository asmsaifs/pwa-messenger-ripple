import * as callsRepo from '../repos/calls';
import type { Env } from '../env';

// The alarm fires at +45s; this cutoff leaves margin so a call that's simply
// mid-ring isn't swept while its own DO alarm is still the primary path
// (docs/03 §5: "alarms are exact but DO deletion is not guaranteed" — this
// only catches the case where the DO itself is gone).
const RINGING_ORPHAN_MS = 60_000;

export async function sweepOrphanRingingCalls(env: Env): Promise<number> {
  const cutoff = Date.now() - RINGING_ORPHAN_MS;
  const orphans = await callsRepo.listOrphanRingingCalls(env, cutoff);
  for (const call of orphans) {
    await callsRepo.markCallMissedDirect(env, call.id);
  }
  return orphans.length;
}
