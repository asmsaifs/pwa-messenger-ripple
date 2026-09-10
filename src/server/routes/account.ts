import { Hono } from 'hono';
import { AppError, notFound } from '../errors';
import { createAuth } from '../lib/auth';
import { enqueueExport } from '../lib/export-queue';
import { presignGetUrl } from '../lib/r2-presign';
import { takeRateLimit } from '../lib/rate-limit';
import { requireAuth } from '../middleware/actor';
import * as policy from '../policy';
import * as accountRepo from '../repos/account';
import {
  deleteAccountResponseSchema,
  deleteAccountSchema,
  exportAccountResponseSchema,
  exportStatusResponseSchema,
} from '../../shared/account';
import type { Env } from '../env';
import type { AuthUser } from '../middleware/actor';
import type { Actor } from '../types';

export const accountRoute = new Hono<{
  Bindings: Env;
  Variables: { actor: Actor; authUser: AuthUser };
}>();

accountRoute.use('*', requireAuth);

// Generous — this stops scripted zip-bomb-by-spam, not a user re-downloading
// their own data a couple of times.
const EXPORT_HOURLY_LIMIT = 3;

accountRoute.post('/export', async (c) => {
  const actor = c.get('actor');
  policy.assertAccountExportable(actor);
  await takeRateLimit(c.env, actor.userId, 'account-export', EXPORT_HOURLY_LIMIT, 60 * 60 * 1000);

  const job = await accountRepo.createExportJob(c.env, actor);
  if (!job) throw new Error('createExportJob returned no row');
  await enqueueExport(c.env, job.id, actor.userId);

  return c.json(exportAccountResponseSchema.parse({ jobId: job.id }));
});

// Not in docs/03's contract table verbatim (which only shows the enqueue
// response) — the "→ { downloadUrl } via push when ready" half needs
// *something* the client can poll/land on after the push notification's
// `/settings` link, and re-presigning per request (rather than baking a
// download URL into the push payload) means the 1h GET TTL never blocks a
// user who opens it late.
accountRoute.get('/export/:jobId', async (c) => {
  const actor = c.get('actor');
  policy.assertAccountExportable(actor);
  const jobId = c.req.param('jobId');
  const job = await accountRepo.getExportJob(c.env, jobId);
  if (!job || job.userId !== actor.userId) notFound();

  if (job.status !== 'ready' || !job.r2Key) {
    return c.json(exportStatusResponseSchema.parse({ status: job.status }));
  }
  const { url } = await presignGetUrl(c.env, job.r2Key);
  return c.json(exportStatusResponseSchema.parse({ status: 'ready', downloadUrl: url }));
});

accountRoute.delete('/', async (c) => {
  const actor = c.get('actor');
  policy.assertAccountDeletable(actor);

  const { password } = deleteAccountSchema.parse(await c.req.json());
  const auth = createAuth(c.env);
  const { status: passwordOk } = await auth.api.verifyPassword({
    body: { password },
    headers: c.req.raw.headers,
  });
  if (!passwordOk) throw new AppError('auth/invalid-credentials');

  // Order matters: revoke every session (including this request's own —
  // fine, nothing below needs it) before anonymizing the profile, so a
  // session refreshed mid-request can't read the pre-anonymize display name
  // back on its way out.
  await auth.api.revokeSessions({ headers: c.req.raw.headers }).catch((err) => {
    console.error('account delete: revokeSessions failed', err);
  });
  await accountRepo.anonymizeProfile(c.env, actor);
  const deletion = await accountRepo.scheduleAccountDeletion(c.env, actor);
  if (!deletion) throw new Error('scheduleAccountDeletion returned no row');

  return c.json(deleteAccountResponseSchema.parse({ purgeAt: deletion.purgeAt }), 202);
});
