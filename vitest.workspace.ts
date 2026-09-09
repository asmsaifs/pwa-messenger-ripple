import path from 'node:path';
import { defineWorkspace } from 'vitest/config';

// Two projects, one `vitest run`: the Workers pool for server/DO/policy
// suites (real D1/Miniflare, no IndexedDB) and a jsdom pool for src/client
// unit tests that need browser APIs (M8's Dexie outbox). See each config's
// own comment for why they can't share one pool.
//
// Absolute paths, not `'./vitest.worker.config.ts'`: Vitest resolves
// workspace member paths against the *root* Vite config's `root` (our
// vite.config.ts sets `root: 'src/client'` for the app build), not against
// this file's own directory — a relative path here silently resolves inside
// src/client instead of the repo root.
export default defineWorkspace([
  path.resolve(__dirname, 'vitest.worker.config.ts'),
  path.resolve(__dirname, 'vitest.client.config.ts'),
]);
