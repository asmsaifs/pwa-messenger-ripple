import * as accountRepo from '../repos/account';
import * as attachmentsRepo from '../repos/attachments';
import * as conversationsRepo from '../repos/conversations';
import { conversationStub } from './conversation-do';
import { userStub } from './user-do';
import type { Env } from '../env';
import type { Actor } from '../types';

// Daily cron (docs/03 §5, docs/05 §9: "purge jobs past their 30-day mark") —
// hard-deletes every account whose grace period has elapsed. Ordering
// matters: DO storage and R2 objects must go *before* the D1 cascade, since
// neither cascades from a D1 delete on their own (docs/02 §1's FK cascades
// only reach other D1 rows) — losing the `attachments`/`conversation_members`
// rows first would leave nothing to enumerate keys/conversation ids from.
export async function purgeDueAccounts(env: Env): Promise<number> {
  const due = await accountRepo.listDueDeletions(env, Date.now());
  for (const row of due) {
    await purgeOneAccount(env, row.userId);
  }
  return due.length;
}

export async function purgeOneAccount(env: Env, userId: string): Promise<void> {
  const actor: Actor = { userId, sessionId: 'system', emailVerified: true };
  const [conversations, attachments] = await Promise.all([
    conversationsRepo.listConversationsForUser(env, actor),
    attachmentsRepo.listByUploader(env, userId),
  ]);

  // Tombstone this user's messages in every conversation DO they've touched
  // — never a full `deleteAll()` there, since the other member's data lives
  // in the same instance (see ConversationDO.purgeUser's comment).
  await Promise.all(
    conversations.map((c) =>
      conversationStub(env, c.id)
        .purgeUser(userId)
        .catch((err) => console.error(`account-purge: ConversationDO.purgeUser failed for ${c.id}`, err)),
    ),
  );
  // UserDO is 1:1 with this user — a full wipe is correct here.
  await userStub(env, userId)
    .purge()
    .catch((err) => console.error(`account-purge: UserDO.purge failed for ${userId}`, err));

  await Promise.all(attachments.map((a) => env.MEDIA.delete(a.r2Key)));
  // Avatar keys are per-user (`avatar/{userId}/{uuid}.webp`, docs/02 §4) —
  // listable by prefix. A user has at most a handful of avatar objects ever
  // (one per change), so the unpaginated first page is always complete in
  // practice; revisit if avatar history grows unbounded.
  const avatarObjects = await env.MEDIA.list({ prefix: `avatar/${userId}/` });
  await Promise.all(avatarObjects.objects.map((o) => env.MEDIA.delete(o.key)));

  await accountRepo.hardDeleteUser(env, userId); // cascades every FK-linked D1 row
  await accountRepo.deleteAccountDeletionRow(env, userId);
}
