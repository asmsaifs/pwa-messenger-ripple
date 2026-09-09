import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { AppError } from '../errors';
import { getSessionWithUser } from '../repos/auth';
import type { Env } from '../env';
import type { Actor } from '../types';

export const SESSION_COOKIE = '__Host-ripple.session';

// Identity comes from the session cookie, never a request body/WS field
// (CLAUDE.md hard rule 4). Interim lookup straight against the `session`/`user`
// tables (docs/05 §2) ahead of Better Auth landing in M3 — same tables, same
// cookie name, so routes written against `c.get('actor')` don't change.
export const requireAuth = createMiddleware<{
  Bindings: Env;
  Variables: { actor: Actor };
}>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) throw new AppError('auth/unauthenticated');

  const row = await getSessionWithUser(c.env, token);
  if (!row || row.expiresAt < Date.now()) throw new AppError('auth/unauthenticated');

  c.set('actor', {
    userId: row.userId,
    sessionId: row.sessionId,
    emailVerified: row.emailVerified === 1,
  });
  await next();
});
