import { Hono } from 'hono';
import { AppError, toErrorResponse } from './errors';
import { csrfProtection } from './middleware/csrf';
import { healthRoute } from './routes/health';
import type { Env } from './env';

const app = new Hono<{ Bindings: Env }>();

app.use('*', csrfProtection);

app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json(toErrorResponse(err), err.status);
  }
  // Anything else is a bug, not an expected app-level failure — it has no
  // taxonomy code (docs/03 §6 lists none for "unhandled"), so this shape is
  // deliberately outside `ErrorResponse` rather than borrowing a misleading one.
  console.error(err);
  return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
});

app.route('/api/health', healthRoute);

// Fallback for anything not handled above: hand off to Workers Static Assets,
// which serves index.html for unmatched paths (SPA client-side routing) per
// `not_found_handling: single-page-application` in wrangler.jsonc.
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
