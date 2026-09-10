import type { Env } from '../env';

// Minimal Sentry error reporting via the raw HTTP envelope API (docs/05 §10)
// — deliberately not the `@sentry/cloudflare` SDK: its Worker wrapper needs
// wrangler v4, and this repo is pinned to 3.114.17 (see wrangler.jsonc's
// EMAIL comment for the same version-gap reasoning). A hand-rolled POST to
// the envelope endpoint needs nothing from the SDK beyond the DSN. Inert
// (no-op) until `SENTRY_DSN` is actually set — see docs/09 M15 checklist.
export async function captureException(
  env: Env,
  err: unknown,
  context?: Record<string, unknown>,
): Promise<void> {
  if (!env.SENTRY_DSN) return;
  try {
    const dsn = new URL(env.SENTRY_DSN);
    const projectId = dsn.pathname.replace(/^\//, '');
    const publicKey = dsn.username;
    const ingestUrl = `https://${dsn.host}/api/${projectId}/envelope/`;
    const eventId = crypto.randomUUID().replace(/-/g, '');
    const event = {
      event_id: eventId,
      timestamp: Date.now() / 1000,
      platform: 'node',
      environment: env.APP_ENV,
      exception: {
        values: [
          {
            type: err instanceof Error ? err.name : 'Error',
            value: err instanceof Error ? err.message : String(err),
          },
        ],
      },
      extra: { ...context, stack: err instanceof Error ? err.stack : undefined },
    };
    const envelope = [
      JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify(event),
    ].join('\n');
    await fetch(ingestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=ripple-worker/1.0, sentry_key=${publicKey}`,
      },
      body: envelope,
    });
  } catch (reportErr) {
    console.error('Sentry report failed', reportErr);
  }
}
