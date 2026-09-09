import { test, expect } from '@playwright/test';
import { makeConversation } from './support/auth';

// docs/07 E2E #4: "Text both directions: receipts, typing indicator, unread badge."
test('text both directions: receipts, typing indicator, unread badge', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  const { conversationId } = await makeConversation(pageA, pageB, 'e2e4');

  await pageA.goto(`/c/${conversationId}`);
  await pageB.goto(`/c/${conversationId}`);
  await expect(pageA.getByTestId('ws-status')).toHaveAttribute('data-status', 'open');
  await expect(pageB.getByTestId('ws-status')).toHaveAttribute('data-status', 'open');

  // A types — B sees the typing indicator.
  await pageA.getByTestId('composer-input').fill('hello there');
  await expect(pageB.getByTestId('peer-status')).toHaveText('typing…');

  // A sends — both sides see the bubble.
  await pageA.getByTestId('composer-send').click();
  await expect(pageA.getByTestId('message-bubble').filter({ hasText: 'hello there' })).toBeVisible();
  await expect(pageB.getByTestId('message-bubble').filter({ hasText: 'hello there' })).toBeVisible();

  // B reads it (ThreadPage sends a `read` frame at the last-seen seq on
  // mount/update) — A's tick turns into the double/read tick.
  await expect(pageA.getByTestId('message-tick').last()).toContainText('✓✓');

  // B replies — direction 2. Wait for B's own read-marker POST to settle
  // (ThreadPage fires it fire-and-forget on every new `lastSeq`, including
  // its own sends) before navigating away — otherwise the unread count below
  // races an in-flight write instead of reflecting "read everything so far".
  const readMarkerSettled = pageB.waitForResponse(
    (res) => res.url().includes(`/api/conversations/${conversationId}/read`) && res.status() === 204,
  );
  await pageB.getByTestId('composer-input').fill('hi back');
  await pageB.getByTestId('composer-send').click();
  await expect(pageA.getByTestId('message-bubble').filter({ hasText: 'hi back' })).toBeVisible();
  await readMarkerSettled;

  // Unread badge: a 3rd message arrives over HTTP while B is looking at the
  // conversation list instead of the thread — B's list row picks up the count.
  await pageB.goto('/chats');
  await pageA.request.post(`/api/conversations/${conversationId}/messages`, {
    headers: { Origin: 'http://localhost:8787' },
    data: { clientId: 'e2e4-unread', kind: 'text', body: 'while you were away' },
  });
  await expect(pageB.getByTestId('unread-badge')).toHaveText('1', { timeout: 10_000 });

  await contextA.close();
  await contextB.close();
});
