import Dexie, { type Table } from 'dexie';
// Relative, not `@shared`: this module is pulled into src/sw.ts's separate
// bundle (via outbox.ts) alongside the app bundle, and only relative imports
// are guaranteed to resolve in both (see api.ts's note).
import type { Message, MessageKind, Reaction } from '../../shared/messages';
import type { ClientErrorCode } from './api';

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed';

// One row per queued send, keyed by the same `clientId` the DO dedupes on
// (docs/02 §2) — that shared key is what lets the client mutex (outbox.ts's
// `inFlight` set) and the server's `UNIQUE(client_id)` constraint agree on
// "have we sent this yet" without ever talking to each other.
export interface OutboxRow {
  clientId: string;
  conversationId: string;
  kind: MessageKind;
  body?: string;
  attachmentId?: string;
  replyToSeq?: number;
  status: OutboxStatus;
  attempts: number;
  createdAt: number;
  lastErrorCode?: ClientErrorCode;
}

export interface MessageRow extends Message {
  conversationId: string;
}

export interface MetaRow {
  key: string;
  value: number;
}

// Downloaded attachment bytes, cached so a re-open of the thread doesn't
// re-fetch through a fresh presigned GET (docs/02 §7: "blobs LRU over
// 300 MB"). `fetchedAt` drives that LRU eviction.
export interface BlobRow {
  attachmentId: string;
  blob: Blob;
  mimeType: string;
  fetchedAt: number;
}

// Mirrors ConversationDO's `reactions` table (docs/02 §2) client-side. Needed
// because the server only resends reactions for messages actually included
// in a `backfill` frame (docs/03 §2.1) — on a reload where `lastSeq` already
// matches the server (nothing new to backfill), an in-memory-only reaction
// state would come back empty even though the reaction still exists
// server-side. Caching it the same way `messages`/`lastSeq` already are
// (docs/02 §7) is what makes it survive a refresh.
export interface ReactionRow extends Reaction {
  conversationId: string;
}

// Schema mirrors docs/02 §7 verbatim (the client/server contract for
// IndexedDB layout) so later milestones (M9 attachments, M4-era conversation
// list caching) can start using `blobs`/`conversations` without a schema
// migration of their own.
class RippleDB extends Dexie {
  outbox!: Table<OutboxRow, string>;
  messages!: Table<MessageRow, [string, number]>;
  meta!: Table<MetaRow, string>;
  blobs!: Table<BlobRow, string>;
  reactions!: Table<ReactionRow, [string, number, string, string]>;

  constructor() {
    super('ripple');
    this.version(1).stores({
      conversations: 'id, lastMessageAt',
      messages: '[conversationId+seq], conversationId, clientId, createdAt',
      outbox: 'clientId, status, createdAt',
      blobs: 'attachmentId',
      meta: 'key',
    });
    this.version(2).stores({
      reactions: '[conversationId+seq+userId+emoji], conversationId, [conversationId+seq]',
    });
  }
}

export const db = new RippleDB();

export function lastSeqMetaKey(conversationId: string): string {
  return `lastSeq:${conversationId}`;
}
