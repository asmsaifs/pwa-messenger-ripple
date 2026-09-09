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

**M0 — Repo & toolchain** complete: Vite + React 19 + TS strict + Tailwind 4 +
shadcn/ui on the client, Hono on Workers + Static Assets serving the SPA,
`@cloudflare/vitest-pool-workers` wired for server tests, ESLint layering
rules (drizzle/`env.DB` restricted to `src/server/repos/**`, added ahead of
M1), CI skeleton. See `docs/09-ROADMAP.md` for what's next (M1: D1 schema +
repos).
