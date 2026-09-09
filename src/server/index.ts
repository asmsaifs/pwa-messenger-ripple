import { Hono } from 'hono';
import { ZodError } from 'zod';
import { AppError, toErrorResponse } from './errors';
import { createAuth } from './lib/auth';
import { csrfProtection } from './middleware/csrf';
import { friendsRoute } from './routes/friends';
import { healthRoute } from './routes/health';
import { invitesRoute } from './routes/invites';
import { meRoute } from './routes/me';
import type { Env } from './env';

// Workers requires every Durable Object class referenced in wrangler.jsonc's
// bindings to be exported from the main module (CLAUDE.md hard rule 9).
export { RateLimiterDO } from '../durable/RateLimiterDO';

const app = new Hono<{ Bindings: Env }>();

app.use('*', csrfProtection);

// Better Auth owns its own request/response contract for these — not routed
// through src/shared zod schemas like hand-written routes (CLAUDE.md rule 5
// only applies to shapes this app defines).
app.on(['GET', 'POST'], '/api/auth/*', (c) => createAuth(c.env).handler(c.req.raw));

app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json(toErrorResponse(err), err.status);
  }
  // A route's own zod parse (CLAUDE.md rule 5) throwing is a malformed
  // request, not a bug — give it the same taxonomy'd shape as everything else.
  if (err instanceof ZodError) {
    return c.json(
      toErrorResponse(new AppError('validation/invalid', err.issues)),
      400,
    );
  }
  // Anything else is a bug, not an expected app-level failure — it has no
  // taxonomy code (docs/03 §6 lists none for "unhandled"), so this shape is
  // deliberately outside `ErrorResponse` rather than borrowing a misleading one.
  console.error(err);
  return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
});

app.route('/api/health', healthRoute);
app.route('/api/me', meRoute);
app.route('/api/friends', friendsRoute);
app.route('/api/invites', invitesRoute);

// Fallback for anything not handled above: hand off to Workers Static Assets,
// which serves index.html for unmatched paths (SPA client-side routing) per
// `not_found_handling: single-page-application` in wrangler.jsonc.
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
