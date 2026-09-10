import { describe, expect, it } from 'vitest';
import type { PushPayload } from '@shared/push';
import { callIdFromNotificationUrl, notificationOptionsFor } from './push-notification-options';

function callPayload(overrides: Partial<PushPayload> = {}): PushPayload {
  return {
    type: 'call',
    title: 'A',
    body: 'Incoming call',
    tag: 'call-abc123',
    data: { url: '/call/abc123' },
    ...overrides,
  };
}

describe('notificationOptionsFor', () => {
  it('gives a call push Accept/Decline actions and requireInteraction (docs/04 §"Incoming (backgrounded)")', () => {
    const options = notificationOptionsFor(callPayload());
    expect(options.requireInteraction).toBe(true);
    expect(options.actions).toEqual([
      { action: 'decline', title: 'Decline' },
      { action: 'accept', title: 'Accept' },
    ]);
    expect(options.tag).toBe('call-abc123');
  });

  it('closes a ringing notification via the call_cancelled tag match, no actions of its own', () => {
    const options = notificationOptionsFor(
      callPayload({ type: 'call_cancelled', title: 'Missed call', body: '' }),
    );
    expect(options.requireInteraction).toBe(false);
    expect(options.actions).toBeUndefined();
  });

  it('leaves non-call pushes as plain transient notifications', () => {
    const options = notificationOptionsFor({
      type: 'message',
      title: 'B',
      body: 'hi',
      tag: 'conv-1',
      data: { url: '/c/1' },
    });
    expect(options.requireInteraction).toBe(false);
    expect(options.actions).toBeUndefined();
  });
});

describe('callIdFromNotificationUrl', () => {
  it('extracts the id from a /call/:id url', () => {
    expect(callIdFromNotificationUrl('/call/abc123')).toBe('abc123');
  });
});
