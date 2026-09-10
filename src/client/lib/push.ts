import { pushSubscribeSchema } from '@shared/push';
import { apiFetch } from './api';
import { z } from 'zod';

// Subscribe UX (docs/06 §3, docs/09 M12): request permission → pushManager.
// subscribe → POST the subscription to the server. Mirrors
// install-prompt.ts's shape (module-level capability check + a small client
// API) rather than a query hook, since there's no server data to cache here
// — just one-shot browser Permission/PushManager calls.

export function pushSupported(): boolean {
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window &&
    Boolean(import.meta.env.VITE_VAPID_PUBLIC_KEY)
  );
}

export function pushPermissionState(): NotificationPermission | 'unsupported' {
  if (!pushSupported()) return 'unsupported';
  return Notification.permission;
}

// `PushManager.subscribe`'s `applicationServerKey` wants a `Uint8Array` of
// the raw decoded key, not the base64url string itself.
function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function postSubscription(subscription: PushSubscription): Promise<void> {
  const json = subscription.toJSON();
  const input = pushSubscribeSchema.parse({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
  });
  await apiFetch<void>('/api/push/subscribe', z.void(), { method: 'POST', body: input });
}

// Requests Notification permission (must be called from a user gesture per
// docs/06 §5: "request only after install/first meaningful action") and, if
// granted, subscribes + registers with the server. Returns the resulting
// permission so the caller can render "denied" without a second check.
export async function enablePush(): Promise<NotificationPermission> {
  if (!pushSupported()) return 'denied';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission;

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      // TS 5.7's generic `Uint8Array<TArrayBuffer>` narrows the plain
      // `new Uint8Array(n)` this builds to `Uint8Array<ArrayBufferLike>`,
      // which isn't structurally assignable to `BufferSource` even though
      // it satisfies it at runtime (a `SharedArrayBuffer`-shaped edge case
      // that never applies here) — the cast is just for that mismatch.
      applicationServerKey: urlBase64ToUint8Array(
        import.meta.env.VITE_VAPID_PUBLIC_KEY ?? '',
      ) as BufferSource,
    }));
  await postSubscription(subscription);
  return permission;
}

// Unsubscribes locally and tells the server to drop the row. Best-effort on
// the server call — if it's offline, the DB row goes stale but harmlessly
// (the consumer self-cleans it on the next 410, docs/09 M12 exit criterion).
export async function disablePush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await apiFetch<void>('/api/push/subscribe', z.void(), {
    method: 'DELETE',
    body: { endpoint },
  }).catch(() => undefined);
}

export async function isPushSubscribed(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return false;
  const subscription = await registration.pushManager.getSubscription();
  return subscription !== null;
}

export async function sendTestPush(): Promise<void> {
  await apiFetch<void>('/api/push/test', z.void(), { method: 'POST' });
}
