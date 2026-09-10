import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePushQueue } from './consumer';
import { base64UrlEncode } from '../lib/vapid';
import * as pushRepo from '../repos/push';
import { seedUsers } from '../repos/test-helpers';
import type { Actor } from '../types';

// @cloudflare/workers-types declares `generateKey`/`exportKey` with unioned
// return types instead of per-overload narrowing — see
// src/server/lib/vapid.ts's `generateEcdhKeyPair`/`exportRawPublicKey`.
async function fakeSubscriberKeys(): Promise<{ p256dh: string; auth: string }> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;
  const publicRaw = new Uint8Array(
    (await crypto.subtle.exportKey('raw', keyPair.publicKey)) as ArrayBuffer,
  );
  return {
    p256dh: base64UrlEncode(publicRaw),
    auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
  };
}

function fakeMessage(body: unknown) {
  return { body, ack: vi.fn(), retry: vi.fn() };
}

function fakeBatch(messages: ReturnType<typeof fakeMessage>[]) {
  return { messages } as unknown as MessageBatch<unknown>;
}

describe('push-queue consumer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  let userA: string;
  let actorA: Actor;

  beforeEach(async () => {
    const seeded = await seedUsers(env);
    userA = seeded.userA;
    actorA = { userId: userA, sessionId: 's', emailVerified: true };
  });

  it('acks and marks lastOkAt when the push service accepts the payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Response(null, { status: 201 })),
    );
    const keys = await fakeSubscriberKeys();
    const sub = await pushRepo.upsertPushSubscription(env, actorA, {
      endpoint: 'https://push.example.com/consumer-ok',
      ...keys,
    });

    const message = fakeMessage({
      userId: userA,
      payload: { type: 'message', title: 'A', body: 'hi', tag: 'msg-1', data: { url: '/c/1' } },
      urgency: 'normal',
      ttl: 60,
    });
    await handlePushQueue(fakeBatch([message]), env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    const subs = await pushRepo.listSubscriptionsForUserId(env, userA);
    expect(subs.find((s) => s.id === sub!.id)?.lastOkAt).toBeTruthy();
  });

  it('410 self-cleans the subscription row (docs/09 M12 exit criterion)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Response(null, { status: 410 })),
    );
    const keys = await fakeSubscriberKeys();
    await pushRepo.upsertPushSubscription(env, actorA, {
      endpoint: 'https://push.example.com/consumer-410',
      ...keys,
    });

    const message = fakeMessage({
      userId: userA,
      payload: { type: 'message', title: 'A', body: 'hi', tag: 'msg-1', data: { url: '/c/1' } },
      urgency: 'normal',
      ttl: 60,
    });
    await handlePushQueue(fakeBatch([message]), env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    const subs = await pushRepo.listSubscriptionsForUserId(env, userA);
    expect(subs).toHaveLength(0);
  });

  it('404 also self-cleans', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Response(null, { status: 404 })),
    );
    const keys = await fakeSubscriberKeys();
    await pushRepo.upsertPushSubscription(env, actorA, {
      endpoint: 'https://push.example.com/consumer-404',
      ...keys,
    });

    const message = fakeMessage({
      userId: userA,
      payload: { type: 'message', title: 'A', body: 'hi', tag: 'msg-1', data: { url: '/c/1' } },
      urgency: 'normal',
      ttl: 60,
    });
    await handlePushQueue(fakeBatch([message]), env);

    const subs = await pushRepo.listSubscriptionsForUserId(env, userA);
    expect(subs).toHaveLength(0);
  });

  it('429 retries the message and keeps the subscription row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Response(null, { status: 429 })),
    );
    const keys = await fakeSubscriberKeys();
    await pushRepo.upsertPushSubscription(env, actorA, {
      endpoint: 'https://push.example.com/consumer-429',
      ...keys,
    });

    const message = fakeMessage({
      userId: userA,
      payload: { type: 'message', title: 'A', body: 'hi', tag: 'msg-1', data: { url: '/c/1' } },
      urgency: 'normal',
      ttl: 60,
    });
    await handlePushQueue(fakeBatch([message]), env);

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    const subs = await pushRepo.listSubscriptionsForUserId(env, userA);
    expect(subs).toHaveLength(1);
  });

  it('5xx retries the message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Response(null, { status: 503 })),
    );
    const keys = await fakeSubscriberKeys();
    await pushRepo.upsertPushSubscription(env, actorA, {
      endpoint: 'https://push.example.com/consumer-503',
      ...keys,
    });

    const message = fakeMessage({
      userId: userA,
      payload: { type: 'message', title: 'A', body: 'hi', tag: 'msg-1', data: { url: '/c/1' } },
      urgency: 'normal',
      ttl: 60,
    });
    await handlePushQueue(fakeBatch([message]), env);

    expect(message.retry).toHaveBeenCalledOnce();
  });

  it('a user with no subscriptions is a no-op ack', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const message = fakeMessage({
      userId: 'usr_nobody',
      payload: { type: 'message', title: 'A', body: 'hi', tag: 'msg-1', data: { url: '/c/1' } },
      urgency: 'normal',
      ttl: 60,
    });
    await handlePushQueue(fakeBatch([message]), env);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a malformed job body retries rather than throwing unhandled', async () => {
    const message = fakeMessage({ nonsense: true });
    await handlePushQueue(fakeBatch([message]), env);
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });
});
