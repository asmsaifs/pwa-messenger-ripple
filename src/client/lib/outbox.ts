import { db, type OutboxRow } from './db';
import { apiFetch, ApiError } from './api';
// Relative, not `@shared` — see db.ts's note; this file is imported from
// src/sw.ts as well as the app bundle.
import {
  sendMessageInputSchema,
  sendMessageResponseSchema,
  type Message,
  type MessageKind,
} from '../../shared/messages';

export type { OutboxRow, OutboxStatus } from './db';

export type EnqueueInput = {
  clientId: string;
  conversationId: string;
  kind: MessageKind;
  body?: string;
  attachmentId?: string;
  replyToSeq?: number;
};

// Guards against redundant *in-process* re-sends of the same clientId — e.g.
// the WS-open handler, the composer, and a Background Sync tick all deciding
// to flush at once. It does NOT need to (and can't) coordinate across tabs or
// across the SW/page boundary; the DO's `UNIQUE(client_id)` constraint
// (docs/02 §2) is what makes cross-process retries idempotent. Both layers
// exist because neither can do the other's job: this one avoids firing
// redundant requests, the DO's is the actual correctness guarantee.
const inFlight = new Set<string>();

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

// Lets UI (useConversationSocket) re-read outbox status after a mutation
// without polling — cheaper than pulling in dexie-react-hooks for one query.
export function subscribeOutbox(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function scheduleBackgroundSync(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    await registration.sync.register('outbox-flush');
  } catch {
    // Unsupported (Firefox/Safari) or denied — useOutboxFlusher's online
    // listener and foreground-interval fallback (docs/06 §5) still cover it.
  }
}

export async function enqueueOutboxMessage(input: EnqueueInput): Promise<void> {
  const row: OutboxRow = {
    ...input,
    status: 'pending',
    attempts: 0,
    createdAt: Date.now(),
  };
  await db.outbox.put(row);
  notify();
  void scheduleBackgroundSync();
}

export async function listOutbox(conversationId: string): Promise<OutboxRow[]> {
  const rows = await db.outbox.toArray();
  return rows
    .filter((row) => row.conversationId === conversationId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

async function sendOverHttp(entry: OutboxRow): Promise<Message> {
  const input = sendMessageInputSchema.parse({
    clientId: entry.clientId,
    kind: entry.kind,
    body: entry.body,
    attachmentId: entry.attachmentId,
    replyToSeq: entry.replyToSeq,
  });
  const { message } = await apiFetch(
    `/api/conversations/${entry.conversationId}/messages`,
    sendMessageResponseSchema,
    { method: 'POST', body: input },
  );
  return message;
}

// Sends one queued entry, guarded so at most one attempt for a given
// `clientId` is ever in flight from this tab at a time.
export async function flushOutboxEntry(clientId: string): Promise<void> {
  if (inFlight.has(clientId)) return;
  inFlight.add(clientId);
  try {
    const entry = await db.outbox.get(clientId);
    if (!entry || entry.status === 'sent' || entry.status === 'sending') return;
    await db.outbox.update(clientId, { status: 'sending' });
    notify();
    try {
      await sendOverHttp(entry);
      await db.outbox.update(clientId, { status: 'sent' });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'net/offline') {
        // Not a failure worth surfacing — just still offline. Leave it
        // `pending` so the UI keeps showing the optimistic ⏳, not an error.
        await db.outbox.update(clientId, { status: 'pending' });
      } else {
        await db.outbox.update(clientId, {
          status: 'failed',
          attempts: entry.attempts + 1,
          lastErrorCode: err instanceof ApiError ? err.code : 'internal',
        });
      }
    }
    notify();
  } finally {
    inFlight.delete(clientId);
  }
}

// Flushes every queued conversation's outbox, in send order. Sequential
// rather than `Promise.all` so a burst of queued messages lands in the order
// they were composed (docs/07 E2E #9: "flushed in order").
export async function flushOutbox(): Promise<void> {
  const entries = await db.outbox
    .where('status')
    .anyOf('pending', 'failed')
    .sortBy('createdAt');
  for (const entry of entries) {
    await flushOutboxEntry(entry.clientId);
  }
}

export async function retryOutboxEntry(clientId: string): Promise<void> {
  await flushOutboxEntry(clientId);
}

// Called when a message shows up via the WS echo/backfill instead of this
// tab's own flush (e.g. `sendMessage` took the live-socket fast path) — the
// outbox row for it would otherwise sit `pending` forever and get re-sent
// (harmlessly, but wastefully — the DO dedupes) on the next flush tick.
export async function markOutboxSent(clientId: string): Promise<void> {
  const existing = await db.outbox.get(clientId);
  if (!existing || existing.status === 'sent') return;
  await db.outbox.update(clientId, { status: 'sent' });
  notify();
}
