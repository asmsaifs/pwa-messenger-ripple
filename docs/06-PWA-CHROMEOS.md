# 06 — PWA & Chrome OS Specifics

## 1. Manifest (`public/manifest.webmanifest`)
```json
{
  "id": "/?source=pwa",
  "name": "Ripple — Voice & Chat",
  "short_name": "Ripple",
  "start_url": "/?source=pwa",
  "scope": "/",
  "display": "standalone",
  "display_override": ["window-controls-overlay", "standalone", "minimal-ui"],
  "orientation": "any",
  "background_color": "#0b1220",
  "theme_color": "#0b1220",
  "categories": ["social", "productivity"],
  "launch_handler": { "client_mode": "navigate-existing" },
  "icons": [
    { "src": "/icons/192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" },
    { "src": "/icons/mono.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "monochrome" }
  ],
  "screenshots": [
    { "src": "/screenshots/wide.png", "sizes": "1280x800", "type": "image/png", "form_factor": "wide" },
    { "src": "/screenshots/narrow.png", "sizes": "720x1280", "type": "image/png", "form_factor": "narrow" }
  ],
  "shortcuts": [
    { "name": "New chat", "url": "/chats?new=1", "icons": [{ "src": "/icons/shortcut-chat.png", "sizes": "96x96" }] },
    { "name": "Friends", "url": "/friends", "icons": [{ "src": "/icons/shortcut-friends.png", "sizes": "96x96" }] }
  ],
  "share_target": {
    "action": "/share",
    "method": "POST",
    "enctype": "multipart/form-data",
    "params": { "title": "title", "text": "text", "files": [{ "name": "files", "accept": ["image/*", "audio/*", "application/pdf"] }] }
  },
  "file_handlers": [
    { "action": "/share", "accept": { "image/*": [".png", ".jpg", ".webp"] } }
  ],
  "protocol_handlers": [
    { "protocol": "web+ripple", "url": "/invite/%s" }
  ]
}
```
`launch_handler: navigate-existing` matters: an incoming-call notification must focus the **existing** window, not spawn a second instance (two instances = two mic grabs).

## 2. Service worker (`src/sw.ts`, Workbox injectManifest)
Responsibilities:
1. **Precache** app shell (`self.__WB_MANIFEST`), `skipWaiting` only on explicit user "Update available → Reload" (never auto-reload mid-call).
2. **Runtime caching**
   - Navigation: NetworkFirst w/ 3 s timeout → offline shell.
   - Static assets (hashed): CacheFirst, 1 year.
   - Avatars: StaleWhileRevalidate, 7 days, max 100 entries.
   - `/api/*` and all WebSocket traffic: **NetworkOnly** (never cache authenticated data).
   - Presigned R2 URLs: never cached by the SW (they expire; cache the fetched blob in Dexie instead).
3. **Push**: `push` handler per 03-API-CONTRACTS §4. Call pushes use `requireInteraction` + action buttons.
4. **notificationclick**: focus existing client via `clients.matchAll({type:'window', includeUncontrolled:true})` then `client.focus()` + `postMessage({type:'NAV', url})`; only `openWindow` if none.
5. **Background Sync**: tag `outbox-flush` → replay queued messages. Fallback to a foreground interval when Background Sync is unavailable.
6. **Periodic Background Sync** (Chrome OS supports it for installed PWAs): tag `refresh-badge` every 12 h → update app badge via `navigator.setAppBadge`.

Update UX: `registerSW({ onNeedRefresh })` → toast "New version available · Reload". Suppress the toast while `callStore.status !== 'idle'`.

## 3. Chrome OS behaviors to handle explicitly
| Behavior | Handling |
|---|---|
| Lid close / tab hidden during call | `navigator.wakeLock.request('screen')` on call start, re-acquire on `visibilitychange`; release on end |
| Audio focus with other apps | Use `<audio autoplay playsinline>` sink; set `AudioContext` only when needed |
| Output device selection | `HTMLMediaElement.setSinkId()` (Chromium-only, fine here); enumerate after permission granted or labels are empty |
| Bluetooth headset swap mid-call | listen `navigator.mediaDevices.ondevicechange` → re-enumerate, offer "Switch to <device>" toast; `replaceTrack` for input change without renegotiation |
| Notification permission is per-origin | request only after install/first meaningful action |
| Badging | `navigator.setAppBadge(unreadCount)` / `clearAppBadge()` — supported on Chrome OS |
| Install prompt | capture `beforeinstallprompt`, stash, show custom Install button in header + /welcome; log `appinstalled` |
| Tablet mode / touch | hit targets ≥ 44 px, hold-to-record must work with touch and pointer events |
| Low-end Chromebooks | avoid heavy canvas waveform on 60 fps; throttle to 20 fps, use `requestAnimationFrame` gated on visibility |
| Screen keyboard resize | use `100dvh` + `visualViewport` listener to keep composer above keyboard |

## 4. Audio pipeline
```ts
const stream = await navigator.mediaDevices.getUserMedia({
  audio: {
    echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    channelCount: 1, sampleRate: 48000,
    deviceId: preferredInputId ? { exact: preferredInputId } : undefined,
  },
});
```
- Encoder prefs on the sender: `sender.setParameters({ encodings:[{ maxBitrate: 32_000 }] })`, prefer Opus with `usedtx=1; useinbandfec=1` munged into SDP (or `RTCRtpSender.setCodecPreferences`).
- Voice messages: `MediaRecorder(stream, { mimeType:'audio/webm;codecs=opus', audioBitsPerSecond: 32000 })`. Feature-detect; fall back to `audio/ogg;codecs=opus`.
- Waveform: `AudioContext.decodeAudioData` → 64 RMS buckets → store `smallint[]` so the receiver renders without decoding.

## 5. Lighthouse / install criteria gate (CI)
PWA installability: HTTPS, manifest with name/icons/start_url/display, registered SW with a fetch handler. CI runs Lighthouse and fails the build under: Performance 90, Accessibility 95, Best Practices 95, SEO 90, and any failed PWA audit.

## 6. Optional: Play Store distribution (v2)
Bubblewrap → TWA APK, requires Digital Asset Links at `/.well-known/assetlinks.json`. Not needed for Chrome OS install; only for Play listing.
