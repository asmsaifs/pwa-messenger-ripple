import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

// docs/06 §4: `notificationclick` in src/sw.ts focuses the existing window
// and `postMessage({type:'NAV', url})`s it rather than navigating directly —
// this is the other half, mounted once for the authenticated shell (same
// lifetime as useUserSocket in AppLayout), that turns that message into an
// in-app route change instead of a full reload.
export function usePushNotificationNav(): void {
  const navigate = useNavigate();

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | undefined;
      if (data?.type === 'NAV' && data.url) void navigate(data.url);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);
}
