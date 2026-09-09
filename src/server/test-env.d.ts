import type { Env } from './env';

// `TEST_MIGRATIONS` is injected only by vitest.config.ts (readD1Migrations)
// for `applyD1Migrations` in vitest.setup.ts — it is not a real Worker binding.
declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
