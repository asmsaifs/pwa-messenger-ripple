// Worker bindings, grown one field at a time as milestones add infrastructure
// (D1 in M1, Durable Objects in M2/M6+, R2/KV/Queues later — see docs/08 §2).
export interface Env {
  APP_ENV: string;
  APP_BASE_URL: string;
  ASSETS: Fetcher;
}
