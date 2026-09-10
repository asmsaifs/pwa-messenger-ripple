import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  deleteAccountResponseSchema,
  exportAccountResponseSchema,
  exportStatusResponseSchema,
  sessionsResponseSchema,
  type DeleteAccountInput,
} from '@shared/account';
import { apiFetch } from '../api';

export const sessionsQueryKey = ['sessions'] as const;

export function useSessions() {
  return useQuery({
    queryKey: sessionsQueryKey,
    queryFn: () => apiFetch('/api/me/sessions', sessionsResponseSchema),
    staleTime: 30_000,
  });
}

export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      await apiFetch<void>(`/api/me/sessions/${sessionId}`, z.void(), { method: 'DELETE' });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sessionsQueryKey }),
  });
}

export function useStartExport() {
  return useMutation({
    mutationFn: () =>
      apiFetch('/api/account/export', exportAccountResponseSchema, { method: 'POST' }),
  });
}

// Polled from the Data section once a jobId exists (docs/03: the push
// notification is the primary "it's ready" signal, but a user sitting on the
// Settings page shouldn't have to wait for one — see refetchInterval below).
export function useExportStatus(jobId: string | undefined) {
  return useQuery({
    queryKey: ['export-status', jobId] as const,
    queryFn: () => apiFetch(`/api/account/export/${jobId}`, exportStatusResponseSchema),
    enabled: Boolean(jobId),
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 3_000 : false),
  });
}

export function useDeleteAccount() {
  return useMutation({
    mutationFn: (input: DeleteAccountInput) =>
      apiFetch('/api/account', deleteAccountResponseSchema, { method: 'DELETE', body: input }),
  });
}
