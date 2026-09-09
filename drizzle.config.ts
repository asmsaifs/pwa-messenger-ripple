import { defineConfig } from 'drizzle-kit';

// `pnpm drizzle-kit generate` reads src/server/schema.ts and writes
// migrations/NNNN_*.sql. See docs/02 §8 for the full migration workflow.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/server/repos/schema.ts',
  out: './migrations',
});
