import { createMiddleware } from 'hono/factory';
import { AppError } from '../errors';
import type { Env } from '../env';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// SameSite=Lax blocks cross-site POSTs from forms but not every vector, so
// every unsafe method and every WS upgrade re-checks Origin explicitly
// (docs/05 §3) — browsers don't apply CORS to WebSocket upgrades. The
// allowlist is read from `env` per-request (not passed in at mount time)
// because `APP_BASE_URL` is a Worker binding, only available once a request
// arrives.
export const csrfProtection = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const isUpgrade = c.req.header('Upgrade')?.toLowerCase() === 'websocket';
  if (!UNSAFE_METHODS.has(c.req.method) && !isUpgrade) {
    await next();
    return;
  }

  const secFetchSite = c.req.header('Sec-Fetch-Site');
  if (secFetchSite === 'same-origin' || secFetchSite === 'none') {
    await next();
    return;
  }

  const allowedOrigins = [c.env.APP_BASE_URL, 'http://localhost:5173'];
  const origin = c.req.header('Origin');
  if (origin && allowedOrigins.includes(origin)) {
    await next();
    return;
  }

  throw new AppError('auth/csrf');
});
