import { useOnlineStatus } from '../lib/online-status';

// docs/04 §4: global offline banner. Full "queued bubbles" / retry UX lands
// with the outbox in M8 — this is just the ambient status strip it plugs into.
export function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;

  return (
    <div
      role="status"
      className="w-full bg-amber-100 px-4 py-2 text-center text-sm text-amber-900"
    >
      You're offline — messages will send when you're back.
    </div>
  );
}
