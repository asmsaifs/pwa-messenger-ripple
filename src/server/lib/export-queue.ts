import { z } from 'zod';
import type { Env } from '../env';

// Producer side of `export-queue` (docs/03 "Push & account", mirrors
// src/server/lib/push-queue.ts's shape exactly). The only call site is
// `POST /api/account/export`.
export const exportJobPayloadSchema = z.object({ jobId: z.string(), userId: z.string() });
export type ExportJobPayload = z.infer<typeof exportJobPayloadSchema>;

export async function enqueueExport(env: Env, jobId: string, userId: string): Promise<void> {
  const job = exportJobPayloadSchema.parse({ jobId, userId });
  await env.EXPORT_QUEUE.send(job);
}
