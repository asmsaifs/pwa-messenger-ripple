// Cloudflare Email Sending isn't wired until M5 (docs/09-ROADMAP.md — "Email
// Sending templates" is an M5 deliverable, not M3's). Until then, verify/reset
// links are logged so local dev and manual verification can follow them —
// the "local mail catcher" docs/07 §5 (E2E #1) describes. Swap this for a
// real send in M5 without touching call sites in src/server/lib/auth.ts.
export function logAuthEmail(kind: 'verify-email' | 'reset-password', to: string, url: string) {
  console.log(`[auth email] ${kind} -> ${to}: ${url}`);
}
