import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { captcha } from 'better-auth/plugins';
import zxcvbn from 'zxcvbn';
import { getDb } from '../repos/db';
import { getPendingDeletion } from '../repos/account';
import { createProfile } from '../repos/profiles';
import { findUserByEmail } from '../repos/users';
import { sendResetPasswordEmail, sendVerificationEmail } from './mail';
import * as schema from '../repos/schema';
import type { Env } from '../env';

const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30; // 30 days (docs/05 §2)
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24; // rolling refresh at 1 day

// Paths where a plaintext password is being set — zxcvbn score < 2 is
// rejected regardless of the 10-char minimum (docs/05 §2). Runs as a `before`
// hook rather than the `password.hash` override the built-in
// `haveIBeenPwned` plugin uses, so it doesn't need `@better-auth/core` as a
// direct dependency just to read `ctx.path`.
const PASSWORD_STRENGTH_PATHS: Record<string, 'password' | 'newPassword'> = {
  '/sign-up/email': 'password',
  '/reset-password': 'newPassword',
};

// KV's `expirationTtl` floors at 60s — better-auth's built-in auth-endpoint
// rate limiter (auto-enabled once `secondaryStorage` is set) defaults to a
// 10s window, which would make every `increment` throw. Clamping up is the
// safe direction: a slightly longer-lived counter, never a shorter one.
const KV_MIN_TTL_SECONDS = 60;

function kvSecondaryStorage(kv: KVNamespace) {
  return {
    get: (key: string) => kv.get(key),
    getAndDelete: async (key: string) => {
      const value = await kv.get(key);
      if (value !== null) await kv.delete(key);
      return value;
    },
    set: (key: string, value: string, ttl?: number) =>
      kv.put(key, value, ttl ? { expirationTtl: Math.max(ttl, KV_MIN_TTL_SECONDS) } : undefined),
    delete: (key: string) => kv.delete(key),
    // Best-effort read-modify-write, not atomic — KV has no native counter.
    // Fine as defense in depth for auth endpoints; RateLimiterDO (M5) is the
    // real enforcement point for the abuse controls in docs/05 §8.
    increment: async (key: string, ttl: number) => {
      const current = await kv.get(key);
      const next = (current ? Number(current) : 0) + 1;
      await kv.put(key, String(next), { expirationTtl: Math.max(ttl, KV_MIN_TTL_SECONDS) });
      return next;
    },
  };
}

// Per-request factory — `env` (incl. the D1/KV bindings) only exists once a
// request arrives, so this can't be a module-level singleton.
export function createAuth(env: Env) {
  return betterAuth({
    baseURL: env.APP_BASE_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(getDb(env), { provider: 'sqlite', schema }),
    secondaryStorage: kvSecondaryStorage(env.SESSIONS_KV),
    trustedOrigins: [env.APP_BASE_URL, 'http://localhost:5173'],

    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      cookieCache: { enabled: false },
    },

    // `__Host-` requires Secure + Path=/ + no Domain attribute (docs/05 §2).
    // better-auth's own `useSecureCookies` only ever prepends `__Secure-`, so
    // the exact name is set explicitly here with `useSecureCookies` off, and
    // Secure is restored via `defaultCookieAttributes` for every auth cookie.
    advanced: {
      useSecureCookies: false,
      defaultCookieAttributes: { secure: true },
      cookies: {
        session_token: { name: '__Host-ripple.session' },
      },
    },

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      requireEmailVerification: true,
      resetPasswordTokenExpiresIn: 60 * 60, // 1h (docs/05 §2)
      revokeSessionsOnPasswordReset: true, // docs/05 §2: reset revokes every session
      sendResetPassword: ({ user, url }) => sendResetPasswordEmail(env, { to: user.email, url }),
      // Resetting a password revokes every other session (docs/05 §2);
      // better-auth's `/reset-password` does this itself before this hook
      // fires, so there's nothing left to do here beyond the audit log.
      onPasswordReset: ({ user }) => {
        console.log(`[auth] password reset for ${user.email}, sessions revoked`);
        return Promise.resolve();
      },
    },

    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      // docs/05 §2 only mandates a 1h TTL for password-reset tokens; unlike a
      // reset (attacker-triggerable, wants a tight window), a verify link
      // just needs to outlive normal email latency + a distracted user, so
      // it gets a longer one.
      expiresIn: 60 * 60 * 24, // 24h
      sendVerificationEmail: ({ user, url }) => sendVerificationEmail(env, { to: user.email, url }),
    },

    // Keeps verification/reset tokens in D1 (matching docs/02 §1's hand-defined
    // `verification` table) rather than routing them through `secondaryStorage`,
    // which docs/02 §6 reserves for session caching only.
    verification: { storeInDatabase: true },

    databaseHooks: {
      user: {
        create: {
          // Profile bootstrap (M3 deliverable): every user row gets a 1:1
          // `profiles` row the moment it's created, not deferred to first
          // login — so `GET /api/me` never has to handle "user but no profile".
          after: async (user) => {
            const displayName = user.name || user.email.split('@')[0] || user.email;
            await createProfile(
              env,
              { userId: user.id, sessionId: 'bootstrap', emailVerified: false },
              { displayName },
            );
          },
        },
      },
    },

    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const field = PASSWORD_STRENGTH_PATHS[ctx.path];
        const password = field ? (ctx.body as Record<string, unknown>)?.[field] : undefined;
        if (typeof password === 'string' && zxcvbn(password).score < 2) {
          throw new APIError('BAD_REQUEST', {
            message: 'Password is too easy to guess — choose something less predictable.',
            code: 'WEAK_PASSWORD',
          });
        }

        // docs/05 §9: a scheduled-for-deletion account is immediately
        // unusable, not just "eventually purged" — session revocation at
        // `DELETE /api/account` handles every device already signed in;
        // this closes the other half (a fresh sign-in before the 30-day
        // purge cron runs).
        if (ctx.path === '/sign-in/email') {
          const email = (ctx.body as Record<string, unknown> | undefined)?.email;
          if (typeof email === 'string') {
            const existingUser = await findUserByEmail(env, email);
            const pending = existingUser ? await getPendingDeletion(env, existingUser.id) : undefined;
            if (pending) {
              throw new APIError('FORBIDDEN', {
                message: 'This account is scheduled for deletion.',
                code: 'ACCOUNT_DELETION_PENDING',
              });
            }
          }
        }
      }),
    },

    plugins: env.TURNSTILE_SECRET
      ? [
          captcha({
            provider: 'cloudflare-turnstile',
            secretKey: env.TURNSTILE_SECRET,
            endpoints: ['/sign-up/email'],
          }),
        ]
      : [],
  });
}
