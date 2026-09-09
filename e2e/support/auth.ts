import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { WRANGLER_LOG_FILE } from '../../playwright.config';

// No mail-catcher service exists yet (docs/07 §5 E2E #1 describes one
// conceptually, M6 doesn't own building it) — `sendVerificationEmail` just
// `console.log`s the link (src/server/lib/mail.ts), and `wrangler dev`'s
// stdout is teed to `WRANGLER_LOG_FILE` by playwright.config.ts. Poll it.
async function waitForVerifyLink(email: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(WRANGLER_LOG_FILE)) {
      const lines = fs.readFileSync(WRANGLER_LOG_FILE, 'utf8').split('\n');
      const match = lines
        .filter((l) => l.includes('verify-email') && l.includes(email))
        .at(-1)
        ?.match(/(https?:\/\/\S+)/);
      if (match) return match[1]!;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`timed out waiting for a verify-email link for ${email} in ${WRANGLER_LOG_FILE}`);
}

// Signs up and verifies a user via `page.request` (shares the page's cookie
// jar automatically — Better Auth's `autoSignInAfterVerification` means the
// verify GET itself sets the session cookie, so no manual cookie handling is
// needed) rather than driving the signup form: the subject of these specs is
// text chat (docs/07 E2E #4/#13), not the auth flow (E2E #1) — driving it
// through the UI on every spec would slow the suite for coverage this repo
// gets elsewhere.
// `page.request` doesn't reproduce a browser's `Sec-Fetch-Site` header, so
// the CSRF middleware (src/server/middleware/csrf.ts) falls through to its
// `Origin` allowlist check — set it explicitly on every unsafe-method call.
const ORIGIN_HEADERS = { Origin: 'http://localhost:8787' };

export async function signUpAndVerify(page: Page, email: string, name: string): Promise<string> {
  await page.request.post('/api/auth/sign-up/email', {
    headers: ORIGIN_HEADERS,
    data: { email, password: 'correct horse battery staple', name },
  });
  const verifyUrl = await waitForVerifyLink(email);
  await page.request.get(verifyUrl);

  const me = await page.request.get('/api/me');
  const body = (await me.json()) as { user: { id: string } };
  return body.user.id;
}

// Registered-user invite → accept, mirroring src/server/routes/friends.test.ts's
// `makeConversation` helper but over real HTTP against `wrangler dev`.
export async function makeConversation(
  pageA: Page,
  pageB: Page,
  prefix: string,
): Promise<{ conversationId: string; userIdA: string; userIdB: string }> {
  // `--local` D1/DO storage persists across `wrangler dev` restarts
  // (`.wrangler/state`) — a run-unique suffix keeps repeated local runs of
  // the same spec from hitting an already-verified user from a prior run,
  // where sign-up silently no-ops the verification email and this helper
  // would hang waiting for a link that was never (re-)sent.
  const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const emailA = `${prefix}-a-${runId}@example.com`;
  const emailB = `${prefix}-b-${runId}@example.com`;

  const userIdA = await signUpAndVerify(pageA, emailA, 'A');
  const userIdB = await signUpAndVerify(pageB, emailB, 'B');

  await pageA.request.post('/api/friends/invite', {
    headers: ORIGIN_HEADERS,
    data: { email: emailB },
  });
  const friendsRes = await pageA.request.get('/api/friends');
  const { outgoing } = (await friendsRes.json()) as { outgoing: { friendshipId: string }[] };
  const friendshipId = outgoing[0]!.friendshipId;

  const acceptRes = await pageB.request.post(`/api/friends/${friendshipId}/accept`, {
    headers: ORIGIN_HEADERS,
  });
  const { conversationId } = (await acceptRes.json()) as { conversationId: string };

  return { conversationId, userIdA, userIdB };
}
