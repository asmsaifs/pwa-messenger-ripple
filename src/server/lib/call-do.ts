import type { Env } from '../env';

// `idFromName`/`get`, not `getByName` — see src/server/lib/rate-limit.ts's
// comment: the pinned wrangler/Miniflare (3.114.17) doesn't implement
// `getByName` at runtime yet, even though CLAUDE.md hard rule 9 calls for it.
export function callStub(env: Env, callId: string) {
  return env.CALL.get(env.CALL.idFromName(callId));
}
