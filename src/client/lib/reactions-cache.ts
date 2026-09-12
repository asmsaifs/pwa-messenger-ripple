import type { Reaction } from '@shared/messages';
import { db } from './db';

// Dexie-backed cache for reactions (see db.ts's `ReactionRow` comment for why
// this exists — the server only resends reactions for messages included in a
// `backfill` frame, so a reload with nothing new to backfill needs its own
// local copy to survive).
export async function hydrateReactions(conversationId: string): Promise<Map<number, Reaction[]>> {
  const rows = await db.reactions.where('conversationId').equals(conversationId).toArray();
  const map = new Map<number, Reaction[]>();
  for (const row of rows) {
    const list = map.get(row.seq) ?? [];
    list.push({ seq: row.seq, userId: row.userId, emoji: row.emoji });
    map.set(row.seq, list);
  }
  return map;
}

export async function persistReactions(
  conversationId: string,
  reactions: Reaction[],
): Promise<void> {
  if (reactions.length === 0) return;
  await db.reactions.bulkPut(reactions.map((r) => ({ ...r, conversationId })));
}

export async function persistReaction(
  conversationId: string,
  reaction: Reaction,
  on: boolean,
): Promise<void> {
  if (on) {
    await db.reactions.put({ ...reaction, conversationId });
  } else {
    await db.reactions.delete([conversationId, reaction.seq, reaction.userId, reaction.emoji]);
  }
}
