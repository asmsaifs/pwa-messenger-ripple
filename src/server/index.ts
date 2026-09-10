import { Hono } from 'hono';
import { ZodError } from 'zod';
import { AppError, toErrorResponse } from './errors';
import { createAuth } from './lib/auth';
import { sweepOrphanAttachments } from './lib/attachment-sweep';
import { csrfProtection } from './middleware/csrf';
import { attachmentsRoute } from './routes/attachments';
import { conversationsRoute } from './routes/conversations';
import { friendsRoute } from './routes/friends';
import { healthRoute } from './routes/health';
import { invitesRoute } from './routes/invites';
import { meRoute } from './routes/me';
import { messagesRoute } from './routes/messages';
import { pushRoute } from './routes/push';
import { wsRoute } from './routes/ws';
import { handlePushQueue } from './push/consumer';
import type { Env } from './env';

// Workers requires every Durable Object class referenced in wrangler.jsonc's
// bindings to be exported from the main module (CLAUDE.md hard rule 9).
export { RateLimiterDO } from '../durable/RateLimiterDO';
export { ConversationDO } from '../durable/ConversationDO';
export { UserDO } from '../durable/UserDO';

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
app.route('/api/conversations', conversationsRoute);
app.route('/api/messages', messagesRoute);
app.route('/api/attachments', attachmentsRoute);
app.route('/api/push', pushRoute);
app.route('/api/ws', wsRoute);

// Fallback for anything not handled above: hand off to Workers Static Assets,
// which serves index.html for unmatched paths (SPA client-side routing) per
// `not_found_handling: single-page-application` in wrangler.jsonc.
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  // wrangler.jsonc's `triggers.crons` (M9: orphan attachment sweep). Other
  // cron jobs in docs/03 §5 are added by the milestones that need them —
  // this dispatches on schedule since there's only the one so far.
  scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sweepOrphanAttachments(env));
  },
  // `push-queue` consumer (docs/03 §4, docs/09 M12) — wrangler.jsonc's
  // `queues.consumers` entry routes every enqueued push job here.
  queue(batch: MessageBatch<unknown>, env: Env) {
    return handlePushQueue(batch, env);
  },
};
