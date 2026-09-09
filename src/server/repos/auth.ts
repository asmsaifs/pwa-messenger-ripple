import { eq } from 'drizzle-orm';
import { getDb } from './db';
import { session, user } from './schema';
import type { Env } from '../env';

// Interim session lookup used by the M2 `requireAuth` middleware, ahead of
// Better Auth landing in M3. Same tables Better Auth owns (docs/02 §1) so the
// swap in M3 only changes how the row is validated/rotated, not its shape.
export async function getSessionWithUser(env: Env, token: string) {
  const db = getDb(env);
  const rows = await db
    .select({
      sessionId: session.id,
      userId: session.userId,
      expiresAt: session.expiresAt,
      emailVerified: user.emailVerified,
    })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(eq(session.token, token))
    .limit(1);
  return rows[0];
}
