import { strToU8, zipSync } from 'fflate';
import { conversationStub } from '../lib/conversation-do';
import { exportJobPayloadSchema } from '../lib/export-queue';
import { enqueuePush } from '../lib/push-queue';
import * as accountRepo from '../repos/account';
import * as attachmentsRepo from '../repos/attachments';
import * as callsRepo from '../repos/calls';
import * as conversationsRepo from '../repos/conversations';
import * as friendsRepo from '../repos/friends';
import * as profilesRepo from '../repos/profiles';
import type { Env } from '../env';
import type { Actor } from '../types';

// `export-queue` consumer (docs/03 "Push & account", mirrors
// src/server/push/consumer.ts's shape). Not under src/server/routes/ for the
// same reason as the push consumer: the CI route-policy guard only walks
// that directory, and there's no authorization decision here — the producer
// (`POST /api/account/export`) already scoped the job to the requesting
// actor's own userId.
export async function handleExportQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await buildExport(env, message.body);
      message.ack();
    } catch (err) {
      console.error('export-queue: build failed, retrying', err);
      message.retry();
    }
  }
}

async function buildExport(env: Env, rawBody: unknown): Promise<void> {
  const job = exportJobPayloadSchema.parse(rawBody);
  const actor: Actor = { userId: job.userId, sessionId: 'system', emailVerified: true };

  try {
    const [profile, friendships, conversations, attachments, calls] = await Promise.all([
      profilesRepo.getProfile(env, actor, job.userId),
      friendsRepo.listFriendshipsWithProfiles(env, actor),
      conversationsRepo.listConversationsForUser(env, actor),
      attachmentsRepo.listByUploader(env, job.userId),
      callsRepo.listCallsForUser(env, actor),
    ]);

    // Own messages only, from every conversation this user is/was a member of
    // — "everything about me", not a copy of the other member's side too
    // (ConversationDO.exportMessagesFor's own scoping comment).
    const messagesByConversation = await Promise.all(
      conversations.map(async (c) => ({
        conversationId: c.id,
        messages: await conversationStub(env, c.id).exportMessagesFor(job.userId),
      })),
    );

    const files: Record<string, Uint8Array> = {
      'profile.json': strToU8(JSON.stringify(profile, null, 2)),
      'friendships.json': strToU8(
        JSON.stringify(
          friendships.map((f) => ({ ...f.friendship, otherUserId: f.otherUserId })),
          null,
          2,
        ),
      ),
      'attachments.json': strToU8(JSON.stringify(attachments, null, 2)),
      'calls.json': strToU8(JSON.stringify(calls, null, 2)),
    };
    for (const { conversationId, messages } of messagesByConversation) {
      files[`messages/${conversationId}.json`] = strToU8(JSON.stringify(messages, null, 2));
    }

    const zip = zipSync(files);
    const r2Key = `export/${job.userId}/${job.jobId}.zip`;
    await env.MEDIA.put(r2Key, zip, { httpMetadata: { contentType: 'application/zip' } });
    await accountRepo.markExportJobReady(env, job.jobId, r2Key);

    await enqueuePush(
      env,
      job.userId,
      {
        type: 'export_ready',
        title: 'Your data export is ready',
        body: 'Tap to download a copy of your data.',
        tag: `export-${job.jobId}`,
        data: { url: '/settings' },
      },
      { urgency: 'normal', ttl: 60 * 60 * 24 },
    ).catch((err) => console.error('export-queue: push enqueue failed', err));
  } catch (err) {
    await accountRepo.markExportJobFailed(
      env,
      job.jobId,
      err instanceof Error ? err.message : String(err),
    );
    throw err; // still retried at the queue level, bounded by max_retries → export-dlq
  }
}
