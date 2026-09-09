import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../server/env';

// Fixed-window rate limiter (docs/02 §3, docs/03 §3 RPC contract, docs/05 §8
// abuse controls). One DO instance is addressed per caller-scoped key (e.g. a
// user id via `getByName`, CLAUDE.md hard rule 9) — `action` distinguishes
// independent limits within that instance (`invite`, `invite-resend:<id>`, ...)
// so a single DO can back several counters without cross-contaminating them.
export class RateLimiterDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Schema init only (CLAUDE.md hard rule 9) — every other method runs
    // without blocking concurrency. Constructors can't be async, so the
    // promise is intentionally not awaited here; DO method calls still queue
    // behind `blockConcurrencyWhile` internally.
    void ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS counters (
           action TEXT NOT NULL,
           window_start INTEGER NOT NULL,
           count INTEGER NOT NULL,
           PRIMARY KEY (action, window_start)
         )`,
      );
      return Promise.resolve();
    });
  }

  // Attempts to consume one unit of `action`'s budget for the fixed window
  // containing "now". Deterministic window boundaries (not sliding) keep this
  // a single read + single write per call.
  take(action: string, limit: number, windowMs: number): { ok: boolean; retryAfterMs: number } {
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;

    const existing = [
      ...this.ctx.storage.sql.exec<{ count: number }>(
        `SELECT count FROM counters WHERE action = ? AND window_start = ?`,
        action,
        windowStart,
      ),
    ][0];
    const count = existing?.count ?? 0;

    if (count >= limit) {
      return { ok: false, retryAfterMs: windowStart + windowMs - now };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO counters (action, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (action, window_start) DO UPDATE SET count = count + 1`,
      action,
      windowStart,
    );
    // Prior windows for this action are never read again once the current
    // one has started — sweep them here instead of running a cron for it.
    this.ctx.storage.sql.exec(
      `DELETE FROM counters WHERE action = ? AND window_start < ?`,
      action,
      windowStart,
    );

    return { ok: true, retryAfterMs: 0 };
  }
}
