import { createMiddleware } from 'hono/factory';
import type { Env } from '../env';

// docs/05 §4, verbatim policy — set on every Worker response (the Hono app's
// own HTML/JSON), mirrored for static assets in public/_headers since those
// are served by Cloudflare's Static Assets binding, which never runs this
// middleware. `<account>` is `env.R2_ACCOUNT_ID` (the S3-compatible endpoint
// host presigned attachment/export URLs live on); `<origin>` becomes the
// request's own `wss://` origin for the ConversationDO/UserDO/CallDO WS
// upgrades.
export const csp = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  await next();
  // A 101 Switching Protocols response (the WS upgrade routes) carries no
  // document to protect and mutating its headers after the fact risks
  // breaking the handshake — nothing to add here for those.
  if (c.res.status === 101) return;

  const r2Host = `https://${c.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const wsOrigin = `wss://${new URL(c.req.url).host}`;

  c.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' blob: data: ${r2Host}`,
      `media-src 'self' blob: ${r2Host}`,
      `connect-src 'self' ${wsOrigin} ${r2Host} https://*.ingest.sentry.io`,
      "font-src 'self'",
      "worker-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      "form-action 'self'",
      'upgrade-insecure-requests',
    ].join('; '),
  );
  c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'microphone=(self), camera=(self), geolocation=(), payment=(), usb=()');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
});
