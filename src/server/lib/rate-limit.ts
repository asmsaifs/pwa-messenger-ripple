import { AppError } from '../errors';
import type { Env } from '../env';

// Thin wrapper over the RateLimiterDO RPC contract (docs/03 §3) that turns a
// denied `take()` into the app's error taxonomy. `key` addresses the DO
// instance — callers scope it per actor/resource so limits never leak across
// users. CLAUDE.md hard rule 9 calls for `getByName`; this repo's pinned
// wrangler/Miniflare (3.114.17, see wrangler.jsonc's EMAIL comment for the
// same version gap) doesn't implement it at runtime even though the type
// exists, so this uses `idFromName`/`get` — the pre-`getByName` equivalent,
// same deterministic per-name routing. Switch back once wrangler is upgraded.
export async function takeRateLimit(
  env: Env,
  key: string,
  action: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key));
  const result = await stub.take(action, limit, windowMs);
  if (!result.ok) {
    throw new AppError('rate/limited', { retryAfterMs: result.retryAfterMs });
  }
}
