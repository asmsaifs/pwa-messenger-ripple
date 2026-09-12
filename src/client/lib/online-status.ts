import { useEffect, useState } from 'react';

const OFFLINE_CONFIRM_DELAY_MS = 3_000;

async function isReachable(): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

// navigator.onLine only reflects OS network-interface state, not real
// reachability — wifi blips / captive portals / Chrome OS interface churn
// fire spurious 'offline' events. Debounce + confirm with a real fetch
// before flipping the banner on, so a momentary blip doesn't show it.
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const goOnline = () => {
      clearTimeout(timer);
      setOnline(true);
    };

    const goOffline = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void isReachable().then((reachable) => {
          if (!cancelled) setOnline(reachable);
        });
      }, OFFLINE_CONFIRM_DELAY_MS);
    };

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}
