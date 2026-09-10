import * as Sentry from '@sentry/react';

// docs/05 §10: `VITE_SENTRY_DSN` is public by nature (it ships in the client
// bundle) but still absent in local dev/CI — inert (no-op) until it's set as
// a build-time env var. Call once from main.tsx before the first render.
export function initSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0,
  });
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!import.meta.env.VITE_SENTRY_DSN) return;
  Sentry.withScope((scope) => {
    if (context) scope.setExtras(context);
    Sentry.captureException(error);
  });
}
