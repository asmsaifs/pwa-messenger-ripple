import { test, expect } from '@playwright/test';
import { makeConversation } from './support/auth';

// docs/07 E2E #9: "Offline: 3 messages queued → reconnect → flushed in
// order, zero duplicates."
test('offline: 3 queued messages flush in order with zero duplicates on reconnect', async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  const { conversationId } = await makeConversation(pageA, pageB, 'e2e9');

  await pageA.goto(`/c/${conversationId}`);
  await pageB.goto(`/c/${conversationId}`);
  await expect(pageA.getByTestId('ws-status')).toHaveAttribute('data-status', 'open');
  await expect(pageB.getByTestId('ws-status')).toHaveAttribute('data-status', 'open');

  await contextA.setOffline(true);

  for (let i = 0; i < 3; i++) {
    await pageA.getByTestId('composer-input').fill(`offline queued ${i}`);
    await pageA.getByTestId('composer-send').click();
  }

  // Queued, not failed: the outbox tells "still offline" apart from a real
  // server error (src/client/lib/outbox.ts) — no retry button should appear.
  await expect(pageA.getByTestId('message-retry')).toHaveCount(0);
  for (let i = 0; i < 3; i++) {
    await expect(
      pageA.getByTestId('message-bubble').filter({ hasText: `offline queued ${i}` }),
    ).toBeVisible();
  }

  await contextA.setOffline(false);

  // Both sides end up with exactly one bubble per message, in the order composed.
  for (let i = 0; i < 3; i++) {
    await expect(
      pageA.getByTestId('message-bubble').filter({ hasText: `offline queued ${i}` }),
    ).toHaveCount(1, { timeout: 15_000 });
    await expect(
      pageB.getByTestId('message-bubble').filter({ hasText: `offline queued ${i}` }),
    ).toHaveCount(1, { timeout: 15_000 });
  }

  const bubbleTexts = await pageB
    .getByTestId('message-bubble')
    .filter({ hasText: 'offline queued' })
    .allTextContents();
  const orderedIndexes = bubbleTexts.map((text) =>
    Number(text.match(/offline queued (\d)/)?.[1]),
  );
  expect(orderedIndexes).toEqual([0, 1, 2]);

  await contextA.close();
  await contextB.close();
});
