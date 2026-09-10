import type { Env } from '../env';

// Local-only fallback: logs the link so local dev and manual verification can
// follow it — the "local mail catcher" docs/07 §5 (E2E #1) describes. Never
// used once `BREVO_API_KEY` is set (docs/02 §1: verify/reset/invite tokens
// must "never [be] stored or logged" once real sending is live).
function logAuthEmail(kind: 'verify-email' | 'reset-password', to: string, url: string) {
  console.log(`[auth email] ${kind} -> ${to}: ${url}`);
}

const FROM_ADDRESS = 'invites@fiqraat.com';
const FROM_NAME = 'Ripple';

// Brevo transactional email API (docs/08 §6). Shared by invite/verify/reset
// sends below. Errors are swallowed after logging — the caller's response
// still succeeds (the underlying row/token exists either way and the action
// can be retried once sending works), and the failure log never includes the
// URL, only the recipient.
async function sendBrevoEmail(
  env: Env,
  input: { to: string; subject: string; text: string; html: string },
  logLabel: string,
): Promise<void> {
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY!,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: FROM_ADDRESS, name: FROM_NAME },
        to: [{ email: input.to }],
        subject: input.subject,
        htmlContent: input.html,
        textContent: input.text,
      }),
    });
    if (!res.ok) {
      console.error(`[${logLabel}] Brevo send failed for ${input.to}: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error(`[${logLabel}] send failed for ${input.to}:`, err);
  }
}

export async function sendInviteEmail(
  env: Env,
  input: { to: string; inviterName: string; url: string },
): Promise<void> {
  if (!env.BREVO_API_KEY) {
    console.log(`[invite email] BREVO_API_KEY not configured — invite to ${input.to} not sent`);
    return;
  }
  const subject = `${input.inviterName} invited you to Ripple`;
  const text = `${input.inviterName} invited you to chat on Ripple.\n\nJoin: ${input.url}\n\nThis link expires in 7 days.`;
  const html = `<p>${escapeHtml(input.inviterName)} invited you to chat on Ripple.</p><p><a href="${escapeHtml(input.url)}">Accept the invite</a></p><p>This link expires in 7 days.</p>`;
  await sendBrevoEmail(env, { to: input.to, subject, text, html }, 'invite email');
}

export async function sendVerificationEmail(env: Env, input: { to: string; url: string }): Promise<void> {
  if (!env.BREVO_API_KEY) {
    logAuthEmail('verify-email', input.to, input.url);
    return;
  }
  const subject = 'Verify your Ripple email';
  const text = `Verify your email to finish setting up Ripple.\n\nVerify: ${input.url}`;
  const html = `<p>Verify your email to finish setting up Ripple.</p><p><a href="${escapeHtml(input.url)}">Verify email</a></p>`;
  await sendBrevoEmail(env, { to: input.to, subject, text, html }, 'verify email');
}

export async function sendResetPasswordEmail(env: Env, input: { to: string; url: string }): Promise<void> {
  if (!env.BREVO_API_KEY) {
    logAuthEmail('reset-password', input.to, input.url);
    return;
  }
  const subject = 'Reset your Ripple password';
  const text = `Reset your Ripple password.\n\nReset: ${input.url}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email.`;
  const html = `<p>Reset your Ripple password.</p><p><a href="${escapeHtml(input.url)}">Reset password</a></p><p>This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>`;
  await sendBrevoEmail(env, { to: input.to, subject, text, html }, 'reset password email');
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}
