import { applyD1Migrations, env } from 'cloudflare:test';

// Applies migrations/*.sql to the in-memory D1 instance once per test file,
// so repo/policy/API suites all see the real schema (docs/07 §1: "real D1").
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
