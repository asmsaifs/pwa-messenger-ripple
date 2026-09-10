import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  conversationDetailResponseSchema,
  conversationsListResponseSchema,
  type MuteConversationInput,
  type SetReadMarkerInput,
} from '@shared/conversations';
import { apiFetch } from '../api';

export const conversationsQueryKey = ['conversations'] as const;
export const conversationQueryKey = (id: string) => ['conversations', id] as const;

export function useConversations() {
  return useQuery({
    queryKey: conversationsQueryKey,
    queryFn: () => apiFetch('/api/conversations', conversationsListResponseSchema),
    staleTime: 5_000,
    // UserDO's `unread` push (docs/09 M7, src/client/lib/ws/userSocket.ts)
    // keeps `unreadCount` current in real time; this poll is just a safety
    // net for previews/new rows while the personal socket is reconnecting.
    refetchInterval: 30_000,
  });
}

export function useConversation(id: string | undefined) {
  return useQuery({
    queryKey: conversationQueryKey(id ?? ''),
    queryFn: () => apiFetch(`/api/conversations/${id}`, conversationDetailResponseSchema),
    enabled: Boolean(id),
    // `peerPresence` has no live push (UserDO doesn't fan out presence
    // changes to friends' sockets, only its owner's own socket) — poll while
    // this thread is open so the header dot doesn't go stale for the length
    // of the visit.
    refetchInterval: 30_000,
  });
}

function useInvalidateConversations() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: conversationsQueryKey });
}

export function useSetReadMarker(conversationId: string) {
  const invalidate = useInvalidateConversations();
  return useMutation({
    mutationFn: (input: SetReadMarkerInput) =>
      apiFetch<void>(`/api/conversations/${conversationId}/read`, z.void(), {
        method: 'POST',
        body: input,
      }),
    onSuccess: invalidate,
  });
}

export function useMuteConversation(conversationId: string) {
  const invalidate = useInvalidateConversations();
  return useMutation({
    mutationFn: (input: MuteConversationInput) =>
      apiFetch<void>(`/api/conversations/${conversationId}/mute`, z.void(), {
        method: 'POST',
        body: input,
      }),
    onSuccess: invalidate,
  });
}
