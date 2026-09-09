import { useRegisterSW } from 'virtual:pwa-register/react';
import { Button } from './ui/button';

// docs/06 §2: "New version available · Reload" toast, and skipWaiting only on
// this explicit click — never auto-reload mid-call. Suppressing it during an
// active call is deferred to M13, which is what introduces `callStore`.
export function UpdateToast() {
  const { offlineReady, needRefresh, updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      // Poll for a new SW roughly once an hour so a long-lived open tab
      // eventually offers the update toast.
      if (!registration) return;
      window.setInterval(() => void registration.update(), 60 * 60 * 1000);
    },
  });

  if (!needRefresh[0] && !offlineReady[0]) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-4 z-50 mx-auto flex w-fit max-w-[calc(100vw-2rem)] items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm shadow-lg"
    >
      <span>{needRefresh[0] ? 'New version available.' : 'Ready to work offline.'}</span>
      {needRefresh[0] && (
        <Button size="sm" onClick={() => void updateServiceWorker(true)}>
          Reload
        </Button>
      )}
    </div>
  );
}
