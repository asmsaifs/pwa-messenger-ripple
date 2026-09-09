import { useEffect, useState } from 'react';

// Chrome-only event, not in lib.dom.d.ts.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

// docs/06 §3: "capture beforeinstallprompt, stash, show custom Install button
// ... log appinstalled." Module-level so the event (fired once, early) isn't
// lost if no component has mounted to listen yet.
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredPrompt = event as BeforeInstallPromptEvent;
  notify();
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  console.log('[pwa] appinstalled');
  notify();
});

export function useInstallPrompt(): { canInstall: boolean; promptInstall: () => Promise<void> } {
  const [canInstall, setCanInstall] = useState(deferredPrompt !== null);

  useEffect(() => {
    const listener = () => setCanInstall(deferredPrompt !== null);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return {
    canInstall,
    promptInstall: async () => {
      if (!deferredPrompt) return;
      await deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      notify();
    },
  };
}
