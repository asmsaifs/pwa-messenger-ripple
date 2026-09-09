import type { Env } from '../env';

// verify/reset links are logged so local dev and manual verification can
// follow them — the "local mail catcher" docs/07 §5 (E2E #1) describes.
export function logAuthEmail(kind: 'verify-email' | 'reset-password', to: string, url: string) {
  console.log(`[auth email] ${kind} -> ${to}: ${url}`);
}

const FROM_ADDRESS = 'invites@ripple.app';
const FROM_NAME = 'Ripple';

// Cloudflare Email Sending (M5, `send_email` binding in wrangler.jsonc —
// domain must be onboarded, docs/08 §deploy). The invite URL carries the raw
// token, which docs/02 §1 says must "never [be] stored or logged" — unlike
// `logAuthEmail` above, this never falls back to printing the URL. If the
// send fails (binding missing locally, domain not yet onboarded, etc.) we log
// only that fact, not the link, and let the caller's response still succeed —
// the invitation row exists either way and can be resent once sending works.
export async function sendInviteEmail(
  env: Env,
  input: { to: string; inviterName: string; url: string },
): Promise<void> {
  if (!env.EMAIL) {
    console.log(`[invite email] EMAIL binding not configured — invite to ${input.to} not sent`);
    return;
  }
  const subject = `${input.inviterName} invited you to Ripple`;
  const text = `${input.inviterName} invited you to chat on Ripple.\n\nJoin: ${input.url}\n\nThis link expires in 7 days.`;
  const html = `<p>${escapeHtml(input.inviterName)} invited you to chat on Ripple.</p><p><a href="${escapeHtml(input.url)}">Accept the invite</a></p><p>This link expires in 7 days.</p>`;
  const raw = buildRawMimeEmail({
    from: { address: FROM_ADDRESS, name: FROM_NAME },
    to: input.to,
    subject,
    text,
    html,
  });

  try {
    // Dynamic import, not a static one: `cloudflare:email` isn't resolvable
    // by every runtime this Worker script loads under (e.g. the pinned local
    // vitest-pool-workers/Miniflare version predates it) — deferring the
    // import until a send is actually attempted (i.e. `env.EMAIL` exists)
    // keeps every other route/test loadable regardless.
    const { EmailMessage } = await import('cloudflare:email');
    const message = new EmailMessage(FROM_ADDRESS, input.to, raw);
    await env.EMAIL.send(message);
  } catch (err) {
    console.error(`[invite email] send failed for ${input.to}:`, err);
  }
}

function buildRawMimeEmail(input: {
  from: { address: string; name: string };
  to: string;
  subject: string;
  text: string;
  html: string;
}): string {
  const boundary = `----ripple-${crypto.randomUUID()}`;
  return [
    `From: ${input.from.name} <${input.from.address}>`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    '',
    input.text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    '',
    input.html,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
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
