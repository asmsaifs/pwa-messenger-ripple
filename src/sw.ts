/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import {
  NetworkFirst,
  CacheFirst,
  StaleWhileRevalidate,
  NetworkOnly,
} from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { flushOutbox } from './client/lib/outbox';
import { pushPayloadSchema } from './shared/push';
import { notificationOptionsFor, callIdFromNotificationUrl } from './client/lib/push-notification-options';

declare let self: ServiceWorkerGlobalScope;

// M4 scope (docs/06 §2): precache the app shell + the caching rules below.
// Push/notificationclick/pushsubscriptionchange land here in M12.

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// Navigation: NetworkFirst w/ short timeout → falls back to the precached
// shell (index.html) when offline, which is what makes "offline load works" true.
// Excludes /api/* — Better Auth's email-verification/reset links are GET
// requests that 302 redirect, and a SW-intercepted `fetch()` for a
// navigation request can't hand a followed-redirect Response back to
// `respondWith()` (browsers reject it), so those must hit the network
// directly instead of going through this route.
registerRoute(
  ({ request, url }) => request.mode === 'navigate' && !url.pathname.startsWith('/api/'),
  new NetworkFirst({
    cacheName: 'navigations',
    networkTimeoutSeconds: 3,
  }),
);

// Hashed static assets (JS/CSS emitted by Vite) — safe to cache forever.
registerRoute(
  ({ request }) => request.destination === 'script' || request.destination === 'style',
  new CacheFirst({
    cacheName: 'static-assets',
    plugins: [new ExpirationPlugin({ maxAgeSeconds: 60 * 60 * 24 * 365 })],
  }),
);

// Avatars (public profile images) — fine to serve stale while revalidating.
registerRoute(
  ({ url }) => url.pathname.startsWith('/avatars/'),
  new StaleWhileRevalidate({
    cacheName: 'avatars',
    plugins: [new ExpirationPlugin({ maxAgeSeconds: 60 * 60 * 24 * 7, maxEntries: 100 })],
  }),
);

// Authenticated API responses and presigned R2 URLs must never be cached
// (CLAUDE.md rule 10, docs/06 §2).
registerRoute(({ url }) => url.pathname.startsWith('/api/'), new NetworkOnly());

// skipWaiting only on explicit user action (posted from the "Update available"
// toast) — never auto-reload mid-call (docs/06 §2).
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as { type?: string } | undefined;
  if (data?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// docs/06 §5: Background Sync tag `outbox-flush` replays the Dexie outbox
// even when every tab for this origin is closed — the one thing the
// foreground-only fallback in useOutboxFlusher can't do. Same `flushOutbox`
// used by the page; it's IndexedDB + fetch, both available in this scope.
self.addEventListener('sync', (event) => {
  if (event.tag === 'outbox-flush') {
    event.waitUntil(flushOutbox());
  }
});

// docs/03 §4 / docs/06 §3: the push service delivers the `aes128gcm`-decrypted
// JSON payload as `event.data` — the browser handles the RFC 8291 decryption
// itself before this handler ever runs, so this only has to parse and render
// it. A push with no listener that shows no notification gets Chrome's
// generic "this site has been updated" fallback and, repeated enough times,
// the browser can revoke the permission — so every code path here calls
// `showNotification`, even the malformed-payload fallback.
self.addEventListener('push', (event: PushEvent) => {
  event.waitUntil(
    (async () => {
      let title = 'Ripple';
      let options: NotificationOptions & { data?: unknown } = {
        body: 'You have a new notification.',
        icon: '/icons/192.png',
        badge: '/icons/192.png',
      };
      let callUrl: string | undefined;
      try {
        const raw: unknown = event.data?.json();
        const payload = pushPayloadSchema.parse(raw);
        title = payload.title;
        options = notificationOptionsFor(payload);
        if (payload.type === 'call') callUrl = payload.data.url;
      } catch (err) {
        console.error('[sw] malformed push payload', err);
      }
      await self.registration.showNotification(title, options);
      // The OS notification sound alone is a single ding, not a ringer — the
      // actual ringtone (src/client/lib/webrtc/ringtone.ts) is WebAudio
      // driven from `callStore`, which only exists inside a page. With no
      // tab open there's no page to drive it, so open one: RequireAuth
      // mounts `initRingtone` on every authenticated route, and CallPage's
      // cold-start hydration (`hydrateCallFromRoute`) flips the store to
      // `incoming-ringing` from the route alone, which is what starts the
      // loop — no WS frame needed. Skipped when a window is already open;
      // that client already has the WS `incoming_call` frame and is ringing
      // (or about to).
      if (callUrl) {
        const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        console.log(
          '[sw] call push',
          callUrl,
          'existing window clients:',
          clientsList.map((c) => ({ url: c.url, visibilityState: c.visibilityState, focused: c.focused })),
        );
        if (clientsList.length === 0) {
          try {
            const opened = await self.clients.openWindow(callUrl);
            console.log('[sw] openWindow result', opened ? opened.url : opened);
          } catch (err) {
            console.error('[sw] openWindow threw', err);
          }
        }
      }
    })(),
  );
});

// docs/06 §3/§4: focus the existing client (never spawn a second window —
// `launch_handler: navigate-existing` in the manifest is the install-time
// half of that same rule) and hand it the target URL via `postMessage`
// rather than navigating the SW-controlled window directly, since a
// `WindowClient.navigate()` call would race the app's own router.
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/';
  // docs/04 §"Incoming (backgrounded)": Decline must work even with no
  // client open at all, so it goes straight to the API from the SW rather
  // than routing through a page — `tag` is `call-<callId>` (docs/03 §4),
  // the same id embedded in `url` (`/call/<callId>`), so either works; `url`
  // avoids a second string format to keep in sync.
  if (event.action === 'decline') {
    const callId = callIdFromNotificationUrl(url);
    event.waitUntil(
      callId
        ? fetch(`/api/calls/${callId}/decline`, {
            method: 'POST',
            credentials: 'same-origin',
          }).catch(() => undefined)
        : Promise.resolve(),
    );
    return;
  }
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      const existing = clientsList[0];
      if (existing) {
        await existing.focus();
        existing.postMessage({ type: 'NAV', url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});

// A `call_cancelled` push (M14) needs to close the ringing notification it
// previously opened — server-side "push-cancel" (docs/01 §4.3) is really
// just another push whose payload's `tag` matches the original, so
// `showNotification` with the same `tag` already replaces it; this handler
// exists for the one case that isn't a replace — the callee's client is
// open and handles it over the WS `call_cancelled` frame instead, so the SW
// only needs to close a notification tag it's not going to get a replacement
// push for. Not exercised until M14 introduces that payload type, but wiring
// it now keeps the push handler above the single source of truth for what
// `tag` means.
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as { type?: string; tag?: string } | undefined;
  if (data?.type === 'CLOSE_NOTIFICATION' && data.tag) {
    const tag = data.tag;
    event.waitUntil(
      self.registration.getNotifications({ tag }).then((notifications) => {
        for (const n of notifications) n.close();
      }),
    );
  }
});

// docs/06 §3: the browser rotates a push subscription (key expiry, browser-
// side maintenance) without any app code running — this event is the only
// place that can react. Reuses the *same* `applicationServerKey` the old
// subscription was created with (carried on `event.oldSubscription`) rather
// than needing the VAPID public key threaded into the SW's own scope, then
// swaps the server's copy: subscribe-new-then-delete-old, not the reverse,
// so a crash/reload between the two steps leaves the server with a working
// subscription rather than none.
self.addEventListener('pushsubscriptionchange', (event: Event) => {
  const pushEvent = event as Event & {
    oldSubscription?: PushSubscription;
    newSubscription?: PushSubscription;
    waitUntil(promise: Promise<unknown>): void;
  };
  pushEvent.waitUntil(
    (async () => {
      const applicationServerKey = pushEvent.oldSubscription?.options.applicationServerKey;
      const newSubscription =
        pushEvent.newSubscription ??
        (await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        }));
      const json = newSubscription.toJSON();
      if (!json.endpoint || !json.keys) return;
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
      });
      if (pushEvent.oldSubscription && pushEvent.oldSubscription.endpoint !== json.endpoint) {
        await fetch('/api/push/subscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ endpoint: pushEvent.oldSubscription.endpoint }),
        }).catch(() => undefined);
      }
    })(),
  );
});
