import { sql } from 'drizzle-orm';
import { getDb } from './db';
import { user } from './schema';
import type { Env } from '../env';

// Better Auth owns the `user` table; this is the one repo function friends
// invite-by-email needs from it (docs/03 "invite" — look up whether the
// address already belongs to a registered user before falling back to an
// email invitation).
//
// Case-insensitive: `user.email` is stored with whatever casing the account
// used at signup, but the invite route always lowercases the input before
// lookup — matching on `eq()` silently missed registered users with any
// uppercase in their stored email, and the code fell through to the
// email-invite branch instead of creating a friendship request.
export async function findUserByEmail(env: Env, email: string) {
  const db = getDb(env);
  return db.query.user.findFirst({ where: sql`lower(${user.email}) = ${email.toLowerCase()}` });
}
