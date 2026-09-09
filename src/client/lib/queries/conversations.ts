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
    // Live cross-conversation updates (a new message arriving while this
    // list is open) are UserDO's job (M7, docs/09) — until then, a short
    // poll keeps unread counts/previews from going stale while the list is
    // on screen, without wiring a second socket just for this milestone.
    refetchInterval: 5_000,
  });
}

export function useConversation(id: string | undefined) {
  return useQuery({
    queryKey: conversationQueryKey(id ?? ''),
    queryFn: () => apiFetch(`/api/conversations/${id}`, conversationDetailResponseSchema),
    enabled: Boolean(id),
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
