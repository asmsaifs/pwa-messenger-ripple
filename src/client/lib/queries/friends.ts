import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  acceptFriendshipResponseSchema,
  friendsResponseSchema,
  inviteByEmailResponseSchema,
  type InviteByEmailInput,
} from '@shared/friends';
import { claimInvitationResponseSchema, invitePreviewResponseSchema } from '@shared/invites';
import { apiFetch } from '../api';

export const friendsQueryKey = ['friends'] as const;

export function useFriends() {
  return useQuery({
    queryKey: friendsQueryKey,
    queryFn: () => apiFetch('/api/friends', friendsResponseSchema),
    staleTime: 30_000,
  });
}

function useInvalidateFriends() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: friendsQueryKey });
}

export function useInviteByEmail() {
  const invalidate = useInvalidateFriends();
  return useMutation({
    mutationFn: (input: InviteByEmailInput) =>
      apiFetch('/api/friends/invite', inviteByEmailResponseSchema, {
        method: 'POST',
        body: input,
      }),
    onSuccess: invalidate,
  });
}

export function useAcceptFriendship() {
  const invalidate = useInvalidateFriends();
  return useMutation({
    mutationFn: (friendshipId: string) =>
      apiFetch(`/api/friends/${friendshipId}/accept`, acceptFriendshipResponseSchema, {
        method: 'POST',
      }),
    onSuccess: invalidate,
  });
}

function useFriendshipAction(action: 'decline' | 'block' | 'unblock') {
  const invalidate = useInvalidateFriends();
  return useMutation({
    mutationFn: async (friendshipId: string) => {
      await apiFetch<void>(`/api/friends/${friendshipId}/${action}`, z.void(), {
        method: 'POST',
      });
    },
    onSuccess: invalidate,
  });
}

export function useDeclineFriendship() {
  return useFriendshipAction('decline');
}

export function useBlockFriendship() {
  return useFriendshipAction('block');
}

export function useUnblockFriendship() {
  return useFriendshipAction('unblock');
}

export function useRemoveFriendship() {
  const invalidate = useInvalidateFriends();
  return useMutation({
    mutationFn: async (friendshipId: string) => {
      await apiFetch<void>(`/api/friends/${friendshipId}`, z.void(), { method: 'DELETE' });
    },
    onSuccess: invalidate,
  });
}

export function useResendInvitation() {
  const invalidate = useInvalidateFriends();
  return useMutation({
    mutationFn: async (invitationId: string) => {
      await apiFetch<void>(`/api/invites/${invitationId}/resend`, z.void(), {
        method: 'POST',
      });
    },
    onSuccess: invalidate,
  });
}

export function useRevokeInvitation() {
  const invalidate = useInvalidateFriends();
  return useMutation({
    mutationFn: async (invitationId: string) => {
      await apiFetch<void>(`/api/invites/${invitationId}`, z.void(), { method: 'DELETE' });
    },
    onSuccess: invalidate,
  });
}

export function useInvitePreview(token: string | undefined) {
  return useQuery({
    queryKey: ['invite-preview', token] as const,
    queryFn: () => apiFetch(`/api/invites/${token}`, invitePreviewResponseSchema),
    enabled: Boolean(token),
    retry: false,
  });
}

export function useClaimInvitation() {
  return useMutation({
    mutationFn: (token: string) =>
      apiFetch(`/api/invites/${token}/claim`, claimInvitationResponseSchema, {
        method: 'POST',
      }),
  });
}
