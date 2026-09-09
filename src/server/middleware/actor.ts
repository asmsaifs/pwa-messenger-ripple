import { createMiddleware } from 'hono/factory';
import { AppError } from '../errors';
import { createAuth } from '../lib/auth';
import type { Env } from '../env';
import type { Actor } from '../types';

// M2's placeholder cookie name — Better Auth (M3) is configured to use this
// exact name (`src/server/lib/auth.ts`), so nothing downstream had to change.
export const SESSION_COOKIE = '__Host-ripple.session';

// Identity comes from the session cookie, never a request body/WS field
// (CLAUDE.md hard rule 4). Better Auth validates the signed cookie and
// resolves the session/user rows itself — this only maps its result onto the
// app's `Actor` shape.
// `authUser` rides alongside `actor` for routes that need Better Auth's own
// fields (email, display name) without a second lookup — `Actor` itself stays
// the fixed `{ userId, sessionId, emailVerified }` shape every repo/policy
// function is written against (docs/02 §"Conventions").
export type AuthUser = { id: string; email: string; name: string };

export const requireAuth = createMiddleware<{
  Bindings: Env;
  Variables: { actor: Actor; authUser: AuthUser };
}>(async (c, next) => {
  const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new AppError('auth/unauthenticated');

  c.set('actor', {
    userId: session.user.id,
    sessionId: session.session.id,
    emailVerified: session.user.emailVerified,
  });
  c.set('authUser', {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
  });
  await next();
});
