# Ripple

PWA voice-chat app for Chrome OS, running entirely on Cloudflare.

**`docs/` is the spec — read it before writing code.** See `CLAUDE.md` for the
build rules and `docs/09-ROADMAP.md` for the milestone plan.

## Quick start

```bash
corepack enable && pnpm install
pnpm cf-typegen      # generate Worker binding types from wrangler.jsonc
pnpm dev             # vite (5173) + wrangler dev (8787), Vite proxies /api → 8787
```

## Commands

```bash
pnpm dev            # vite + wrangler dev
pnpm build           pnpm typecheck      pnpm lint
pnpm test            pnpm format:check
pnpm cf-typegen      # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```

## Status

**M0–M15 complete** — all 15 roadmap milestones shipped: toolchain, D1 schema
+ repos, policy layer, Better Auth, app shell/PWA, friends & invites,
ConversationDO text chat, UserDO + presence, offline outbox, file + camera
attachments, voice messages, push notifications, WebRTC voice calls with
call push/ring, and settings/privacy/hardening/launch. Staging deploy +
Brevo transactional email wired. Current work is post-launch bug fixing
(UI polish, call state, PWA/service-worker edge cases) — see recent commits
and `docs/09-ROADMAP.md` for the full milestone spec.
