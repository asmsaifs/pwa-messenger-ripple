// Better Auth owns its own request/response contract (src/server/index.ts's
// comment on the `/api/auth/*` mount — CLAUDE.md rule 5 only applies to
// shapes this app defines, so these calls are plain fetch, not `apiFetch`).
export class AuthClientError extends Error {}

type AuthInit = Record<string, unknown>;

async function authFetch(path: string, body: AuthInit, captchaResponse?: string): Promise<void> {
  const res = await fetch(`/api/auth${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      // better-auth's captcha plugin (src/server/lib/auth.ts) reads the
      // Turnstile token from this header on `/sign-up/email`.
      ...(captchaResponse ? { 'x-captcha-response': captchaResponse } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json: unknown = await res.json().catch(() => null);
    const message =
      json && typeof json === 'object' && 'message' in json && typeof json.message === 'string'
        ? json.message
        : `Request failed with status ${res.status}`;
    throw new AuthClientError(message);
  }
}

export function signUpEmail(input: {
  email: string;
  password: string;
  name: string;
  captchaResponse?: string;
  // Better Auth redirects here (with the session cookie already set, since
  // `autoSignInAfterVerification` is on) once the verification link is
  // clicked — used to land an invite claim on /invite/claim (docs/03 "Auth"
  // ?invite= flow; see ClaimInvitePage).
  callbackURL?: string;
}): Promise<void> {
  const { captchaResponse, ...body } = input;
  return authFetch('/sign-up/email', body, captchaResponse);
}

export function signInEmail(input: { email: string; password: string }): Promise<void> {
  return authFetch('/sign-in/email', input);
}

export function signOut(): Promise<void> {
  return authFetch('/sign-out', {});
}

export function forgetPassword(input: { email: string }): Promise<void> {
  return authFetch('/forget-password', { ...input, redirectTo: '/reset/confirm' });
}

export function resetPassword(input: { newPassword: string; token: string }): Promise<void> {
  return authFetch('/reset-password', input);
}

export function sendVerificationEmail(input: { email: string; callbackURL?: string }): Promise<void> {
  return authFetch('/send-verification-email', input);
}

// Codes better-auth's GET /verify-email appends to its `?error=` redirect
// (src/server/routes: the `/api/auth/*` catch-all just proxies its handler).
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  TOKEN_EXPIRED: 'That verification link expired. Enter your email below to get a new one.',
  INVALID_TOKEN: 'That verification link is invalid. Enter your email below to get a new one.',
  USER_NOT_FOUND: "That verification link doesn't match an account.",
  INVALID_USER: 'That verification link belongs to a different account.',
};

export function authErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return AUTH_ERROR_MESSAGES[code] ?? 'That link is no longer valid.';
}

export function isResendableAuthError(code: string | null): boolean {
  return code === 'TOKEN_EXPIRED' || code === 'INVALID_TOKEN';
}
