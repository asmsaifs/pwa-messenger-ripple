// Background Sync isn't part of TS's DOM/WebWorker lib (Chromium-only, never
// standardized) but src/client/lib/outbox.ts (registering) and src/sw.ts
// (handling `sync`) both need it — docs/06 §5. Declared here, once, and
// pulled into both the client and SW tsconfig projects (tsconfig.app.json's
// `src/shared/**/*.ts` glob, and tsconfig.sw.json's explicit `include` entry)
// so neither side needs a local `any`.
interface SyncManager {
  register(tag: string): Promise<void>;
  getTags(): Promise<string[]>;
}

interface ServiceWorkerRegistration {
  readonly sync: SyncManager;
}

interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
  readonly lastChance: boolean;
}

interface ServiceWorkerGlobalScopeEventMap {
  sync: SyncEvent;
}
