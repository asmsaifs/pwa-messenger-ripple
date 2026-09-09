# 04 — UX Flows & Screens

## 1. Route map
```
/                     → redirect: authed ? /chats : /welcome
/welcome              → value prop + Install button + Sign up / Log in
/signup /login /reset /reset/confirm
/invite/:token        → invite preview (works logged-out) → signup → auto-friend
/chats                → conversation list (default landing)
/c/:conversationId    → thread
/call/:callId         → full-screen call (also renders as overlay on /c/*)
/friends              → friends + pending in/out + "Invite by email"
/settings             → profile, devices, notifications, storage, data, about
```
Chromebook layout ≥ 1024 px: two-pane (list | thread). < 1024 px: stacked with back nav.

## 2. Key screens

### 2.1 Conversation list
Row: avatar + presence dot · name · last-message preview (kind-aware: "📎 Photo", "🎤 0:12", "📞 Missed call") · time · unread pill. Header: search (client-side v1), New chat, avatar menu. Empty state → "Invite a friend by email".

### 2.2 Thread
- Virtualized list (`@tanstack/react-virtual`), newest at bottom, "jump to latest" FAB.
- Bubbles: own right/primary, peer left/muted. Status ticks: ⏳ pending · ✓ sent · ✓✓ delivered · ✓✓ blue read.
- Day separators, grouped consecutive messages by sender within 5 min.
- Composer bar: `＋` (file, photo, camera) · textarea (Enter send, Shift+Enter newline) · mic (hold-to-record OR tap-to-toggle — support both) · send.
- Header: back · avatar+name+presence/"typing…" · **call button** · overflow (mute, block, report, clear).

### 2.3 Voice message capture
Tap mic → permission → recording UI replaces composer: live waveform, elapsed, slide-left-to-cancel + explicit Cancel/Stop. On stop → preview with play/scrub, Delete, Send. Max 5 min auto-stop with warning at 4:45.

### 2.4 Camera capture
In-app sheet: `getUserMedia({video:{facingMode:'user'}})` preview, shutter, front/back switch (Chromebook usually one cam — hide switch if `enumerateDevices` finds < 2), retake/send. Fallback `<input type="file" accept="image/*" capture>` when `getUserMedia` denied.

### 2.5 Call UI
- **Outgoing**: peer avatar (blurred bg), "Calling…", ring-back tone, End.
- **Incoming (in-app)**: full-screen takeover + ringtone (respect `prefers-reduced-motion`, mute if system DND unknowable), Accept / Decline.
- **Incoming (backgrounded)**: OS notification w/ Accept & Decline actions.
- **Active**: timer, mute, speaker/device picker (`setSinkId`), keypad-free, End. Network-quality chip from `getStats()` (packetsLost, jitter, rtt): Good/Fair/Poor.
- **Minimized**: sticky bar at top of any route ("Calling Sam · 02:14 · tap to return"), rendered from a global call store so navigation never tears down the `RTCPeerConnection`.
- End states: "Call ended · 04:32", "Declined", "No answer", "Connection failed — Retry".

### 2.6 Friends & invites
Tabs: Friends · Requests (in/out) · Invited. Invite form: email input + optional note, inline validation, success toast "Invitation sent to x@y.com". Pending invite rows show Resend (throttled 1/24 h) and Revoke.

### 2.7 Settings
Profile (name, avatar crop, status) · Notifications (permission state + per-type toggles, "Test notification") · Audio devices (input/output picker + mic level meter + test tone) · Storage (cache size + Clear cached media) · Privacy (blocked list) · Data (Export, Delete account) · About (version, build sha, licenses).

## 3. Permission choreography (never ask cold)
| Permission | Asked when | Pre-prompt copy | Denied fallback |
|---|---|---|---|
| Notifications | after first friend accepted, or first incoming call attempt | "Get notified when friends call you" | banner in Settings, in-app only ringing |
| Microphone | on first call / first voice message | "Ripple needs your mic for calls" | full-screen recovery card with chrome://settings/content/microphone deep-link instructions |
| Camera | on first camera capture | — | fall back to file picker |

Detect permanent denial via `navigator.permissions.query({name:'microphone'})` → `'denied'` and show recovery instructions, not a re-prompt.

## 4. Offline & error UX
- Global offline banner ("You're offline — messages will send when you're back").
- Queued bubbles show ⏳ + "Sending…"; tap failed bubble → Retry / Delete.
- Call button disabled offline with tooltip.
- Realtime socket drop → silent reconnect w/ backoff; after 3 failures show "Reconnecting…" chip.
- Error boundary per route; global boundary sends to Sentry with a "Reload" CTA.

## 5. Design tokens (starting point)
- Font: Inter var; sizes 12/14/16/20/24/32.
- Radius: 8 (controls), 16 (bubbles), 24 (sheets).
- Palette: neutral slate scale; primary `#2563eb`; success `#16a34a`; danger `#dc2626`; call-active `#16a34a`; incoming ring pulse uses primary.
- Dark mode via `prefers-color-scheme` + manual override in Settings (`data-theme` on `<html>`).
- Motion: 150 ms ease-out for UI, 300 ms for sheets; all animations behind `prefers-reduced-motion`.

## 6. Accessibility acceptance criteria
- Every icon-only button has `aria-label`; call controls are `role="button"` with pressed state on mute.
- Incoming call announces via `aria-live="assertive"`.
- New-message announcement `aria-live="polite"` when thread not focused.
- Focus trap in modals/sheets; ESC closes; focus returns to invoker.
- Contrast ≥ 4.5:1 for text, 3:1 for UI borders; visible focus ring everywhere.
- Full keyboard: `Ctrl+K` search, `Ctrl+Enter` send, `Ctrl+Shift+M` mute during call, `Ctrl+Shift+H` hang up.
