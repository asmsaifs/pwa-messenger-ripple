import path from 'node:path';
import {
  defineWorkersConfig,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers/config';

// Runs the server/DO/policy suites against real Workers runtime bindings
// (Miniflare) per docs/07 §1 — this is the pool that gives us real D1 now
// that M1 adds it. Client-side unit tests (src/client/lib) also run here for
// now; split out a jsdom project if/when component tests (Testing Library) land.
//
// No `@shared` path alias here: `wrangler dev`'s esbuild bundler doesn't read
// tsconfig paths, so src/server/** and src/durable/** import src/shared/**
// with relative paths to keep dev/test/build resolution identical.
export default defineWorkersConfig(async () => {
  const migrationsPath = path.join(__dirname, 'migrations');
  const migrations = await readD1Migrations(migrationsPath);

  return {
    test: {
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
