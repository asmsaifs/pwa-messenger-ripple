import { eq } from 'drizzle-orm';
import { getDb } from './db';
import { user } from './schema';
import type { Env } from '../env';

// Better Auth owns the `user` table; this is the one repo function friends
// invite-by-email needs from it (docs/03 "invite" — look up whether the
// address already belongs to a registered user before falling back to an
// email invitation).
export async function findUserByEmail(env: Env, email: string) {
  const db = getDb(env);
  return db.query.user.findFirst({ where: eq(user.email, email) });
}
