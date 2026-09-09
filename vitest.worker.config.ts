import path from 'node:path';
import { configDefaults } from 'vitest/config';
import {
  defineWorkersConfig,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers/config';

// Runs the server/DO/policy suites against real Workers runtime bindings
// (Miniflare) per docs/07 §1 — this is the pool that gives us real D1 now
// that M1 adds it. `src/client/**` is excluded: the Workers runtime has no
// IndexedDB, so M8's Dexie-backed outbox tests run under vitest.client.config.ts
// (jsdom + fake-indexeddb) instead — see vitest.workspace.ts.
//
// No `@shared` path alias here: `wrangler dev`'s esbuild bundler doesn't read
// tsconfig paths, so src/server/** and src/durable/** import src/shared/**
// with relative paths to keep dev/test/build resolution identical.
export default defineWorkersConfig(async () => {
  const migrationsPath = path.join(__dirname, 'migrations');
  const migrations = await readD1Migrations(migrationsPath);

  return {
    test: {
      name: 'worker',
      exclude: [...configDefaults.exclude, 'src/client/**'],
      setupFiles: ['./vitest.setup.ts'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: {
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
