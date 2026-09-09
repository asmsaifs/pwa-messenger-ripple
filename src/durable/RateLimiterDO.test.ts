import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// `idFromName`/`get`, not `getByName` (see src/server/lib/rate-limit.ts's
// comment) — the pinned local runtime doesn't implement `getByName` yet.
function stubFor(key: string) {
  return env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key));
}

describe('RateLimiterDO', () => {
  it('allows up to the limit, then denies within the same window', async () => {
    const stub = stubFor('user:invite-limit-test');
    for (let i = 0; i < 10; i++) {
      const result = await stub.take('invite', 10, 24 * 60 * 60 * 1000);
      expect(result.ok).toBe(true);
    }
    const eleventh = await stub.take('invite', 10, 24 * 60 * 60 * 1000);
    expect(eleventh.ok).toBe(false);
    expect(eleventh.retryAfterMs).toBeGreaterThan(0);
  });

  it('keeps independent counters per action on the same DO instance', async () => {
    const stub = stubFor('user:multi-action-test');
    await stub.take('invite', 1, 60_000);
    const inviteAgain = await stub.take('invite', 1, 60_000);
    expect(inviteAgain.ok).toBe(false);

    const resend = await stub.take('resend', 1, 60_000);
    expect(resend.ok).toBe(true);
  });

  it('keeps independent counters per DO instance (key)', async () => {
    const stubA = stubFor('user:a-isolation-test');
    const stubB = stubFor('user:b-isolation-test');
    await stubA.take('invite', 1, 60_000);
    const denied = await stubA.take('invite', 1, 60_000);
    const allowed = await stubB.take('invite', 1, 60_000);
    expect(denied.ok).toBe(false);
    expect(allowed.ok).toBe(true);
  });

  it('rolls over to a fresh budget in the next window', async () => {
    const stub = stubFor('user:rollover-test');
    const windowMs = 500;
    const first = await stub.take('invite', 1, windowMs);
    expect(first.ok).toBe(true);
    const deniedSameWindow = await stub.take('invite', 1, windowMs);
    expect(deniedSameWindow.ok).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, windowMs + 50));
    const afterRollover = await stub.take('invite', 1, windowMs);
    expect(afterRollover.ok).toBe(true);
  });
});
