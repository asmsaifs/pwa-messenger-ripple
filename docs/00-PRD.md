# 00 — Product Requirements (PRD)

## 1. Product
**Ripple** — installable PWA for 1:1 voice calling and messaging, optimized for Chrome OS (Chromebooks), works on any Chromium desktop/Android browser.

## 2. Target user & platform
- Primary: Chrome OS 120+ (Chrome 120+). Installed as PWA via `chrome://apps` / Play-style install prompt.
- Secondary: Chrome/Edge desktop (Win/macOS/Linux), Android Chrome.
- Explicit non-goal v1: iOS Safari full parity (no Web Push on iOS <16.4, no background audio reliability). Degrade gracefully.

## 3. Core features (v1 scope)
| ID | Feature | Notes |
|----|---------|-------|
| F1 | Email+password signup / login / logout / password reset | Better Auth on Workers + D1, email verification required |
| F2 | Profile: display name, avatar, status | Avatar in Storage bucket `avatars` |
| F3 | Friend invitations by email address | Invite pending even if invitee has no account yet ("pre-registration invite") |
| F4 | Friend list, accept/decline/block/remove | Bidirectional edge only after accept |
| F5 | 1:1 text chat, realtime | Optimistic send, delivered/read receipts, typing indicator |
| F5a | Reply-to-message, copy message, emoji reactions | Reply quotes original by `seq`; reactions are per-user-per-emoji toggles stored in ConversationDO, no notification/push of their own |
| F6 | File send | any type, ≤ 25 MB v1, virus-scan hook stub |
| F7 | Photo from camera | `getUserMedia` capture in-app + `<input capture>` fallback; client-side compress |
| F8 | Voice message | MediaRecorder (`audio/webm;codecs=opus`), waveform preview, ≤ 5 min |
| F9 | 1:1 voice call | WebRTC P2P, Opus, mute, speaker select, call timer, reconnect |
| F10 | Ring / incoming call UX | Web Push + in-app ring, accept/decline, missed-call record |
| F11 | Offline shell + message queue | Service worker precache; outbox flushes on reconnect |
| F12 | Install prompt + app icons/shortcuts | `beforeinstallprompt`, maskable icons |

## 4. v2 backlog (explicitly out of v1)
Group calls (SFU), video calls, screen share, E2E encryption (MLS), message search, message edit/delete-for-everyone, call recording, i18n, contact sync, Play Store TWA packaging.

## 5. Non-functional requirements
- **Call setup**: p50 < 1.5 s, p95 < 3 s from accept to first audio.
- **Audio**: Opus 24–48 kbps mono, AEC/NS/AGC on, target MOS ≥ 3.8 on 1 Mbps link.
- **Message delivery**: p95 < 400 ms same-region.
- **Cold start**: LCP < 2.0 s on Chromebook mid-tier (Celeron N4020) over 4G.
- **Bundle**: initial JS ≤ 200 KB gzip; call + recorder code lazy-loaded.
- **Availability**: 99.5% v1.
- **Accessibility**: WCAG 2.1 AA, full keyboard nav, screen-reader labels on call controls.

## 6. Success metrics
- Install→signup completion ≥ 60%.
- Invite accept rate ≥ 40%.
- Call connect success ≥ 97% (incl. TURN relay fallback).
- Crash-free sessions ≥ 99.5%.

## 7. Constraints & risks
| Risk | Mitigation |
|------|-----------|
| Symmetric NAT / school firewall blocks P2P | TURN over TCP/443 + TLS mandatory in ICE config |
| Chrome OS suspends tab on lid close | Wake Lock during call; Push wakes SW for incoming |
| No background service worker audio | Call requires foreground tab; Push notification re-focuses |
| Email invite → spam folder | SPF/DKIM/DMARC on sending domain, plain-text alt, resend throttle |
| Storage abuse | Per-user quota 2 GB, signed URLs, 30-day retention for unopened files |
| Abuse/harassment | Block enforced in the Worker policy layer + signaling layer, report flow, rate limits |

## 8. Compliance
GDPR-shaped: data export endpoint, hard delete within 30 days, DPA with Cloudflare, cookie-free analytics (self-hosted Umami or none in v1). No call recording ⇒ no wiretap consent surface.
