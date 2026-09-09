import { useEffect } from 'react';
import { flushOutbox } from './outbox';

const FALLBACK_INTERVAL_MS = 20_000;

function supportsBackgroundSync(): boolean {
  return 'serviceWorker' in navigator && 'SyncManager' in window;
}

// Mounted once at the app root. Background Sync (registered per-enqueue in
// outbox.ts) is what lets the outbox drain with every tab closed, but it
// doesn't cover everything: this fills the two gaps docs/06 §5 calls out —
// an immediate flush on load/reconnect for snappy UX, and a foreground poll
// on browsers with no Background Sync (Firefox, Safari) so those users
// aren't stuck until they happen to reopen the tab.
export function useOutboxFlusher(): void {
  useEffect(() => {
    void flushOutbox();

    const onOnline = () => void flushOutbox();
    window.addEventListener('online', onOnline);

    let interval: ReturnType<typeof setInterval> | null = null;
    if (!supportsBackgroundSync()) {
      interval = setInterval(() => void flushOutbox(), FALLBACK_INTERVAL_MS);
    }

    return () => {
      window.removeEventListener('online', onOnline);
      if (interval) clearInterval(interval);
    };
  }, []);
}
