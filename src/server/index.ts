import { Hono } from 'hono';
import { healthRoute } from './routes/health';
import type { Env } from './env';

const app = new Hono<{ Bindings: Env }>();

app.route('/api/health', healthRoute);

// Fallback for anything not handled above: hand off to Workers Static Assets,
// which serves index.html for unmatched paths (SPA client-side routing) per
// `not_found_handling: single-page-application` in wrangler.jsonc.
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
