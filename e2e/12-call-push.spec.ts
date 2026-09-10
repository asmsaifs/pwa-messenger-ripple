import { test, expect } from '@playwright/test';
import { makeConversation } from './support/auth';

// docs/07 E2E #12: "Push: call while the receiver's tab is hidden →
// notification with Accept/Decline (headed run)".
//
// A real round trip through the Web Push service (docs/03 §4's push-queue →
// VAPID/aes128gcm → the browser's push endpoint) needs outbound network to
// whatever push service Chromium is configured against — not something this
// suite can depend on for every PR. Instead this exercises the exact code
// M14 added: B's tab is genuinely hidden (a second page steals OS focus, so
// `document.hidden` flips for real, matching "receiver's tab is hidden"),
// the call still rings B over the already-open UserDO socket (the socket
// staying alive while backgrounded is the common case; a socket that *did*
// drop is what would route through push instead — that server-side enqueue
// is covered by CallDO's own tests), and B's real service worker handles a
// real `notificationclick` for both actions — Decline hits the real
// `/api/calls/:id/decline` route with no page involved, and Accept
// (identical to a plain click, since accepting needs a document context for
// mic access) focuses/navigates B's hidden tab, which is then brought
// forward and answered — B is "answered from a backgrounded tab" for real.
// The notification's shape (Accept/Decline actions, requireInteraction) is
// covered directly by src/client/lib/push-notification-options.test.ts.
test('call push: decline and accept actions from a backgrounded tab', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext({ permissions: ['notifications'] });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  const { conversationId } = await makeConversation(pageA, pageB, 'e2e12');

  await pageA.goto(`/c/${conversationId}`);
  const [swB] = await Promise.all([
    contextB.waitForEvent('serviceworker'),
    pageB.goto('/chats'), // AppLayout route: UserDO socket + usePushNotificationNav both live here
  ]);
  await pageB.waitForFunction(() => navigator.serviceWorker.controller !== null);

  // Background B: a second page in the same context takes OS focus, so B's
  // `document.hidden` becomes true without closing B or its sockets.
  const distractor = await contextB.newPage();
  await distractor.bringToFront();
  await expect.poll(() => pageB.evaluate(() => document.hidden)).toBe(true);

  // ── Decline ──────────────────────────────────────────────────────────
  await pageA.getByTestId('call-button').click();
  await expect(pageA.getByRole('status').filter({ hasText: 'Calling…' })).toBeVisible();
  await expect(pageB.getByTestId('call-minimized-bar')).toBeVisible(); // rings B over the live socket, tab hidden or not

  const callId1 = (await pageB.getByTestId('call-minimized-bar').getAttribute('data-call-id')) ?? '';
  expect(callId1).not.toBe('');

  await swB.evaluate(
    // `self` in this callback is a ServiceWorkerGlobalScope at runtime, but
    // the e2e project's `lib` only carries DOM types (no `lib.webworker`,
    // which would collide with DOM's own globals) — cast the SW-only bits
    // (`registration`, the `NotificationEvent` constructor) rather than
    // pulling in a second lib.
    async ({ id }) => {
      const registration = (self as unknown as { registration: ServiceWorkerRegistration }).registration;
      // DOM lib's `NotificationOptions` (this file's tsconfig) predates the
      // `actions` field that WebWorker lib (src/sw.ts's own build) has —
      // cast rather than pull in a second lib for one test file.
      await registration.showNotification(
        'A',
        {
          tag: `call-${id}`,
          data: { url: `/call/${id}` },
          requireInteraction: true,
          actions: [
            { action: 'decline', title: 'Decline' },
            { action: 'accept', title: 'Accept' },
          ],
        } as NotificationOptions,
      );
      const [notification] = await registration.getNotifications({ tag: `call-${id}` });
      const NotificationEventCtor = (
        self as unknown as {
          NotificationEvent: new (type: string, init: { notification: Notification; action?: string }) => Event;
        }
      ).NotificationEvent;
      self.dispatchEvent(new NotificationEventCtor('notificationclick', { notification: notification!, action: 'decline' }));
    },
    { id: callId1 },
  );

  // The SW hit the real decline route with no page involved — A sees it over
  // its already-open CallDO signaling socket.
  await expect(pageA.getByRole('status').filter({ hasText: 'Declined' })).toBeVisible();
  await expect(pageB.getByTestId('call-minimized-bar')).toHaveCount(0);

  // ── Accept, answered from the backgrounded tab ─────────────────────────
  await distractor.bringToFront();
  await expect.poll(() => pageB.evaluate(() => document.hidden)).toBe(true);

  await pageA.getByTestId('call-button').click();
  await expect(pageB.getByTestId('call-minimized-bar')).toBeVisible();
  const callId2 = (await pageB.getByTestId('call-minimized-bar').getAttribute('data-call-id')) ?? '';
  expect(callId2).not.toBe('');

  await swB.evaluate(
    async ({ id }) => {
      const registration = (self as unknown as { registration: ServiceWorkerRegistration }).registration;
      await registration.showNotification('A', {
        tag: `call-${id}`,
        data: { url: `/call/${id}` },
        requireInteraction: true,
      });
      const [notification] = await registration.getNotifications({ tag: `call-${id}` });
      const NotificationEventCtor = (
        self as unknown as {
          NotificationEvent: new (type: string, init: { notification: Notification; action?: string }) => Event;
        }
      ).NotificationEvent;
      self.dispatchEvent(new NotificationEventCtor('notificationclick', { notification: notification!, action: 'accept' }));
    },
    { id: callId2 },
  );

  // The click's `postMessage({type:'NAV', url})` landed on B's still-hidden
  // tab and routed it to the full-screen call UI even though it wasn't
  // focused — this is the "backgrounded tab" half of the exit criterion.
  await pageB.waitForURL(`**/call/${callId2}`);

  // The user now brings the tab forward and actually answers.
  await pageB.bringToFront();
  await pageB.getByRole('button', { name: 'Accept' }).click();

  await expect(pageA.getByRole('status')).toContainText(/^\d:\d\d$/, { timeout: 15_000 });
  await expect(pageB.getByRole('status')).toContainText(/^\d:\d\d$/, { timeout: 15_000 });

  await contextA.close();
  await contextB.close();
});
