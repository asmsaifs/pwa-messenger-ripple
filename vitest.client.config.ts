import path from 'node:path';
import { defineConfig } from 'vitest/config';

// jsdom project for src/client/** unit tests that need real browser APIs the
// Workers pool (vitest.worker.config.ts) doesn't provide — first tenant is
// M8's Dexie-backed outbox, via `fake-indexeddb` (Dexie needs a real-ish
// `indexedDB` global; Miniflare's Workers runtime has none). See
// vitest.workspace.ts for how the two projects run together.
export default defineConfig({
  test: {
    name: 'client',
    environment: 'jsdom',
    include: ['src/client/**/*.test.{ts,tsx}'],
    setupFiles: ['fake-indexeddb/auto'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/client'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
});
