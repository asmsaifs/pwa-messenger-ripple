import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import * as policy from './index';
import { createPendingAttachment, markAttachmentReady } from '../repos/attachments';
import { createCall } from '../repos/calls';
import { seedFriendGraph } from '../repos/test-helpers';
import { AppError } from '../errors';

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('policy', () => {
  let g: Awaited<ReturnType<typeof seedFriendGraph>>;

  beforeEach(async () => {
    g = await seedFriendGraph(env);
  });

  describe('assertProfileReadable', () => {
    it('allow: self', async () => {
      await expect(
        policy.assertProfileReadable(env, g.actorA, g.userA),
      ).resolves.toBeUndefined();
    });

    it('allow: accepted friend', async () => {
      await expect(
        policy.assertProfileReadable(env, g.actorA, g.userB),
      ).resolves.toBeUndefined();
    });

    it('deny: stranger gets not-found, not forbidden', async () => {
      await expectCode(
        policy.assertProfileReadable(env, g.actorA, g.userC),
        'policy/not-found',
      );
    });

    it('deny: blocked friend gets not-found (no existence leak)', async () => {
      await expectCode(
        policy.assertProfileReadable(env, g.actorA, g.userD),
        'policy/not-found',
      );
    });
  });

  describe('assertProfileUpdatable', () => {
    it('allow: self', () => {
      expect(() => policy.assertProfileUpdatable(g.actorA, g.userA)).not.toThrow();
    });

    it('deny: spoofed target id changes nothing', () => {
      expect(() => policy.assertProfileUpdatable(g.actorA, g.userB)).toThrow(AppError);
    });
  });

  describe('assertCanCreateFriendship', () => {
    it('allow: stranger', async () => {
      await expect(
        policy.assertCanCreateFriendship(env, g.actorA, g.userC),
      ).resolves.toBeUndefined();
    });

    it('deny: self', async () => {
      await expectCode(
        policy.assertCanCreateFriendship(env, g.actorA, g.userA),
        'policy/forbidden',
      );
    });

    it('deny: already accepted', async () => {
      await expectCode(
        policy.assertCanCreateFriendship(env, g.actorA, g.userB),
        'policy/forbidden',
      );
    });
  });

  describe('assertCanRespondToFriendship', () => {
    it('allow: the other member responds', async () => {
      await expect(
        policy.assertCanRespondToFriendship(env, g.actorB, g.friendshipId),
      ).resolves.toBeDefined();
    });

    it('deny: the requester cannot respond to their own request', async () => {
      await expectCode(
        policy.assertCanRespondToFriendship(env, g.actorA, g.friendshipId),
        'policy/forbidden',
      );
    });

    it('deny: stranger', async () => {
      await expectCode(
        policy.assertCanRespondToFriendship(env, g.actorC, g.friendshipId),
        'policy/not-found',
      );
    });
  });

  describe('assertCanUnblockFriendship', () => {
    it('allow: the blocker', async () => {
      const blockedFriendshipId = (
        await policy.assertConversationMember(env, g.actorA, g.blockedConversationId)
      ).friendshipId;
      await expect(
        policy.assertCanUnblockFriendship(env, g.actorA, blockedFriendshipId),
      ).resolves.toBeDefined();
    });

    it('deny: the blocked party cannot unblock themselves', async () => {
      const blockedFriendshipId = (
        await policy.assertConversationMember(env, g.actorD, g.blockedConversationId)
      ).friendshipId;
      await expectCode(
        policy.assertCanUnblockFriendship(env, g.actorD, blockedFriendshipId),
        'policy/forbidden',
      );
    });
  });

  describe('assertCanInviteByEmail', () => {
    it('allow: verified email', () => {
      expect(() => policy.assertCanInviteByEmail(g.actorA)).not.toThrow();
    });

    it('deny: unverified email', () => {
      expect(() => policy.assertCanInviteByEmail(g.actorE)).toThrow(AppError);
      let code: string | undefined;
      try {
        policy.assertCanInviteByEmail(g.actorE);
      } catch (err) {
        code = err instanceof AppError ? err.code : undefined;
      }
      expect(code).toBe('auth/unverified-email');
    });
  });

  describe('assertConversationMember', () => {
    it('allow: member', async () => {
      await expect(
        policy.assertConversationMember(env, g.actorA, g.conversationId),
      ).resolves.toBeDefined();
    });

    it('deny: stranger gets not-found', async () => {
      await expectCode(
        policy.assertConversationMember(env, g.actorC, g.conversationId),
        'policy/not-found',
      );
    });
  });

  describe('assertCanSendMessage', () => {
    it('allow: verified member of an accepted conversation', async () => {
      await expect(
        policy.assertCanSendMessage(env, g.actorA, g.conversationId),
      ).resolves.toBeUndefined();
    });

    it('deny: blocked conversation returns policy/blocked', async () => {
      await expectCode(
        policy.assertCanSendMessage(env, g.actorA, g.blockedConversationId),
        'policy/blocked',
      );
    });

    it('deny: stranger gets not-found', async () => {
      await expectCode(
        policy.assertCanSendMessage(env, g.actorC, g.conversationId),
        'policy/not-found',
      );
    });

    it('deny: unverified email, even as a member', async () => {
      // E isn't a member of A/B's conversation, but the verified-email check
      // must fire before the membership lookup — spoofing a conversationId
      // an unverified actor isn't even in must not leak membership info either.
      await expectCode(
        policy.assertCanSendMessage(env, g.actorE, g.conversationId),
        'auth/unverified-email',
      );
    });
  });

  describe('assertCanEditOrDeleteMessage', () => {
    it('allow: sender', () => {
      expect(() => policy.assertCanEditOrDeleteMessage(g.actorA, g.userA)).not.toThrow();
    });

    it('deny: a spoofed sender field changes nothing', () => {
      expect(() => policy.assertCanEditOrDeleteMessage(g.actorB, g.userA)).toThrow(
        AppError,
      );
    });
  });

  describe('assertCanSignAttachmentUpload', () => {
    it('allow: member, within quota', async () => {
      await expect(
        policy.assertCanSignAttachmentUpload(env, g.actorA, g.conversationId, 1024),
      ).resolves.toBeUndefined();
    });

    it('deny: oversize upload', async () => {
      await expectCode(
        policy.assertCanSignAttachmentUpload(env, g.actorA, g.conversationId, 26_214_401),
        'upload/too-large',
      );
    });

    it('deny: stranger is not a member', async () => {
      await expectCode(
        policy.assertCanSignAttachmentUpload(env, g.actorC, g.conversationId, 1024),
        'policy/not-found',
      );
    });
  });

  describe('assertAttachmentReadable', () => {
    it('allow: member, ready attachment', async () => {
      const created = await createPendingAttachment(env, g.actorA, {
        conversationId: g.conversationId,
        r2Key: `att/${g.conversationId}/x.png`,
        mimeType: 'image/png',
        byteSize: 10,
      });
      await markAttachmentReady(env, g.actorA, created!.id, {});

      const readable = await policy.assertAttachmentReadable(env, g.actorB, created!.id);
      expect(readable.id).toBe(created!.id);
    });

    it('deny: pending attachment is not yet readable', async () => {
      const created = await createPendingAttachment(env, g.actorA, {
        conversationId: g.conversationId,
        r2Key: `att/${g.conversationId}/y.png`,
        mimeType: 'image/png',
        byteSize: 10,
      });
      await expectCode(
        policy.assertAttachmentReadable(env, g.actorB, created!.id),
        'policy/not-found',
      );
    });

    it('deny: non-member (stranger) gets not-found', async () => {
      const created = await createPendingAttachment(env, g.actorA, {
        conversationId: g.conversationId,
        r2Key: `att/${g.conversationId}/z.png`,
        mimeType: 'image/png',
        byteSize: 10,
      });
      await markAttachmentReady(env, g.actorA, created!.id, {});
      await expectCode(
        policy.assertAttachmentReadable(env, g.actorC, created!.id),
        'policy/not-found',
      );
    });
  });

  describe('assertCanStartCall', () => {
    it('allow: verified member of an accepted conversation, no open call', async () => {
      await expect(
        policy.assertCanStartCall(env, g.actorA, g.conversationId, g.userB),
      ).resolves.toBeUndefined();
    });

    it('deny: blocked conversation', async () => {
      await expectCode(
        policy.assertCanStartCall(env, g.actorA, g.blockedConversationId, g.userD),
        'policy/blocked',
      );
    });

    it('deny: an already-ringing call blocks a second one', async () => {
      await createCall(env, g.actorA, {
        conversationId: g.conversationId,
        calleeId: g.userB,
      });
      await expectCode(
        policy.assertCanStartCall(env, g.actorA, g.conversationId, g.userB),
        'call/busy',
      );
    });

    it('deny: unverified email', async () => {
      await expectCode(
        policy.assertCanStartCall(env, g.actorE, g.conversationId, g.userB),
        'auth/unverified-email',
      );
    });
  });

  describe('assertCanActOnCall', () => {
    it('allow: caller or callee', async () => {
      const call = await createCall(env, g.actorA, {
        conversationId: g.conversationId,
        calleeId: g.userB,
      });
      await expect(
        policy.assertCanActOnCall(env, g.actorB, call!.id),
      ).resolves.toBeDefined();
    });

    it('deny: stranger gets not-found', async () => {
      const call = await createCall(env, g.actorA, {
        conversationId: g.conversationId,
        calleeId: g.userB,
      });
      await expectCode(
        policy.assertCanActOnCall(env, g.actorC, call!.id),
        'policy/not-found',
      );
    });
  });

  describe('assertCanRegisterPushSub', () => {
    it('allow: self', () => {
      expect(() => policy.assertCanRegisterPushSub(g.actorA, g.userA)).not.toThrow();
    });

    it('deny: a spoofed owner id changes nothing', () => {
      expect(() => policy.assertCanRegisterPushSub(g.actorA, g.userB)).toThrow(AppError);
    });
  });
});
