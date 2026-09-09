import * as attachmentsRepo from '../repos/attachments';
import type { Env } from '../env';

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

// Cron job (docs/03 §5: "expire pending attachments >24h") — the client
// signed an upload and either never PUT the bytes or never called
// `/complete`. Deletes the R2 object (harmless no-op if it was never
// written) and the row; unlike a sniff-mismatch failure (docs/05 §7), a row
// that never reached `ready` never touched `storage_used`, so there's
// nothing to refund.
export async function sweepOrphanAttachments(env: Env): Promise<number> {
  const cutoff = Date.now() - PENDING_TTL_MS;
  const orphans = await attachmentsRepo.listPendingOlderThan(env, cutoff);
  for (const attachment of orphans) {
    await env.MEDIA.delete(attachment.r2Key);
    await attachmentsRepo.deleteAttachmentRow(env, attachment.id);
  }
  return orphans.length;
}
