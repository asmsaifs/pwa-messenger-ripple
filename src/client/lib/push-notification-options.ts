// Relative import, not the `@shared/*` alias: this file is pulled into both
// tsconfig.app.json's build (client, DOM lib) and tsconfig.sw.json's (the
// service worker, WebWorker lib, no path aliases configured) — the same
// reason src/sw.ts itself imports `./shared/push` rather than `@shared/push`.
import type { PushPayload } from '../../shared/push';

// Pure helpers factored out of src/sw.ts so the notification shape (M14:
// Accept/Decline actions on a call push) is unit-testable without a
// ServiceWorkerGlobalScope — `self.registration.showNotification` itself
// still only runs inside the SW.

// A local shape rather than `NotificationOptions & {...}`: `actions` is only
// on WebWorker lib's richer `NotificationOptions` (what src/sw.ts compiles
// against) — DOM lib's (what this file's own tsconfig.app.json build uses)
// doesn't have it, so an object literal against the ambient type fails
// there. sw.ts's `NotificationOptions & { data?: unknown }`-typed variable
// is a structural superset of this, so assigning the return value back into
// it still type-checks under WebWorker lib.
export type PushNotificationOptions = {
  body: string;
  tag: string;
  icon: string;
  badge: string;
  data?: unknown;
  requireInteraction: boolean;
  // Android maps a web-push notification to a Chrome-owned NotificationChannel;
  // Chrome only grants it IMPORTANCE_HIGH (heads-up popup + sound) when the
  // options include a `vibrate` pattern — omitting it gets IMPORTANCE_DEFAULT,
  // which lands silently in the shade with no heads-up, no matter the push
  // `Urgency` header. Every notification needs one, not just calls.
  vibrate: number[];
  actions?: { action: string; title: string }[] | undefined;
};

export function notificationOptionsFor(payload: PushPayload): PushNotificationOptions {
  return {
    body: payload.body,
    tag: payload.tag,
    icon: '/icons/192.png',
    badge: '/icons/192.png',
    data: payload.data,
    vibrate: payload.type === 'call' ? [300, 200, 300, 200, 300] : [200, 100, 200],
    // Call pushes (M13/M14) need the user to actively accept/decline rather
    // than the notification auto-dismissing — every other type behaves like
    // a normal transient notification (docs/06 §3).
    requireInteraction: payload.type === 'call',
    // docs/04 §"Incoming (backgrounded)": "OS notification w/ Accept &
    // Decline actions." Accept has no SW-only implementation (WebRTC needs a
    // document context for mic access) so it falls through to the default
    // click behavior in src/sw.ts — focus/open at `data.url` and let
    // CallPage's own Accept button finish the job.
    actions:
      payload.type === 'call'
        ? [
            { action: 'decline', title: 'Decline' },
            { action: 'accept', title: 'Accept' },
          ]
        : undefined,
  };
}

// `tag` is `call-<callId>` and `data.url` is `/call/<callId>` (docs/03 §4) —
// either embeds the id; `url` is what src/sw.ts already has in hand at
// `notificationclick` time, so it derives from that rather than parsing `tag`.
export function callIdFromNotificationUrl(url: string): string | undefined {
  return url.split('/').pop();
}
