import { Hono } from 'hono';
import { ZodError } from 'zod';
import { AppError, toErrorResponse } from './errors';
import { createAuth } from './lib/auth';
import { purgeDueAccounts } from './lib/account-purge';
import { sweepOrphanAttachments } from './lib/attachment-sweep';
import { sweepOrphanRingingCalls } from './lib/call-sweep';
import { captureException } from './lib/sentry';
import { csp } from './middleware/csp';
import { csrfProtection } from './middleware/csrf';
import { accountRoute } from './routes/account';
import { attachmentsRoute } from './routes/attachments';
import { callsRoute, turnRoute } from './routes/calls';
import { conversationsRoute } from './routes/conversations';
import { friendsRoute } from './routes/friends';
import { healthRoute } from './routes/health';
import { invitesRoute } from './routes/invites';
import { meRoute } from './routes/me';
import { messagesRoute } from './routes/messages';
import { pushRoute } from './routes/push';
import { wsRoute } from './routes/ws';
import { handleExportQueue } from './export/consumer';
import { handlePushQueue } from './push/consumer';
import type { Env } from './env';

// Workers requires every Durable Object class referenced in wrangler.jsonc's
// bindings to be exported from the main module (CLAUDE.md hard rule 9).
export { RateLimiterDO } from '../durable/RateLimiterDO';
export { ConversationDO } from '../durable/ConversationDO';
export { UserDO } from '../durable/UserDO';
export { CallDO } from '../durable/CallDO';

const app = new Hono<{ Bindings: Env }>();

app.use('*', csrfProtection);
app.use('*', csp);

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
  c.executionCtx.waitUntil(captureException(c.env, err, { path: c.req.path }));
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
app.route('/api/calls', callsRoute);
app.route('/api/turn', turnRoute);
app.route('/api/ws', wsRoute);
app.route('/api/account', accountRoute);

// Fallback for anything not handled above: hand off to Workers Static Assets,
// which serves index.html for unmatched paths (SPA client-side routing) per
// `not_found_handling: single-page-application` in wrangler.jsonc.
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  // wrangler.jsonc's `triggers.crons` (M9: orphan attachment sweep; M13:
  // orphan ringing-call sweep; M15: account-deletion purge). Dispatches on
  // `event.cron` since there's now more than one schedule sharing this one
  // export.
  scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (event.cron === '*/5 * * * *') {
      ctx.waitUntil(sweepOrphanRingingCalls(env));
      return;
    }
    if (event.cron === '0 4 * * *') {
      ctx.waitUntil(purgeDueAccounts(env));
      return;
    }
    ctx.waitUntil(sweepOrphanAttachments(env));
  },
  // `push-queue`/`export-queue` consumers (docs/03 §4, docs/09 M12/M15) —
  // wrangler.jsonc's `queues.consumers` entries route enqueued jobs here,
  // dispatched on `batch.queue` since one Worker now drains both queues.
  queue(batch: MessageBatch<unknown>, env: Env) {
    if (batch.queue === 'export-queue') return handleExportQueue(batch, env);
    return handlePushQueue(batch, env);
  },
};
