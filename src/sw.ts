/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkFirst, CacheFirst, StaleWhileRevalidate, NetworkOnly } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

declare let self: ServiceWorkerGlobalScope;

// M4 scope (docs/06 §2): precache the app shell + the caching rules below.
// Push/notificationclick land in M12, Background Sync in M8, badge refresh in M7 —
// this file grows those handlers when those milestones build the data they need.

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// Navigation: NetworkFirst w/ short timeout → falls back to the precached
// shell (index.html) when offline, which is what makes "offline load works" true.
registerRoute(
  ({ request }) => request.mode === 'navigate',
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
    plugins: [
      new ExpirationPlugin({ maxAgeSeconds: 60 * 60 * 24 * 7, maxEntries: 100 }),
    ],
  }),
);

// Authenticated API responses and presigned R2 URLs must never be cached
// (CLAUDE.md rule 10, docs/06 §2).
registerRoute(({ url }) => url.pathname.startsWith('/api/'), new NetworkOnly());

// skipWaiting only on explicit user action (posted from the "Update available"
// toast) — never auto-reload mid-call (docs/06 §2).
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (event.data === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
