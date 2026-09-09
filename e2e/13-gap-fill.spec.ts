import { test, expect } from '@playwright/test';
import { makeConversation } from './support/auth';

const ORIGIN_HEADERS = { Origin: 'http://localhost:8787' };

// docs/07 E2E #13: "Gap-fill: kill the socket, insert messages via the HTTP
// path from the peer, reconnect → hello{lastSeq} backfills exactly the
// missing range, no dupes, no holes."
test('gap-fill: HTTP-path messages while offline backfill exactly on reconnect', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  const { conversationId } = await makeConversation(pageA, pageB, 'e2e13');

  await pageA.goto(`/c/${conversationId}`);
  await expect(pageA.getByTestId('ws-status')).toHaveAttribute('data-status', 'open');

  // Kill A's socket by leaving the thread (the WS connection closes on
  // unmount, per useConversationSocket's cleanup) — B's peer stays "offline"
  // from A's perspective.
  await pageA.goto('/chats');

  // Peer sends 3 messages over the HTTP fallback path while A's socket is down.
  for (let i = 0; i < 3; i++) {
    const res = await pageB.request.post(`/api/conversations/${conversationId}/messages`, {
      headers: ORIGIN_HEADERS,
      data: { clientId: `e2e13-${i}`, kind: 'text', body: `offline message ${i}` },
    });
    expect(res.ok()).toBe(true);
  }

  // A reconnects (re-opens the thread) — `hello{lastSeq}` backfills exactly
  // the missing range: no dupes, no holes.
  await pageA.goto(`/c/${conversationId}`);
  for (let i = 0; i < 3; i++) {
    await expect(
      pageA.getByTestId('message-bubble').filter({ hasText: `offline message ${i}` }),
    ).toBeVisible();
  }
  // No dupes: each body appears in exactly one bubble.
  await expect(pageA.getByTestId('message-bubble').filter({ hasText: 'offline message 0' })).toHaveCount(1);
  await expect(pageA.getByTestId('message-bubble').filter({ hasText: 'offline message 1' })).toHaveCount(1);
  await expect(pageA.getByTestId('message-bubble').filter({ hasText: 'offline message 2' })).toHaveCount(1);

  await contextA.close();
  await contextB.close();
});
