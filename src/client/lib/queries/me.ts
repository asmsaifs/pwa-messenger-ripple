import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { meResponseSchema, type MeResponse, type UpdateMeInput } from '@shared/me';
import { apiFetch, ApiError } from '../api';

export const meQueryKey = ['me'] as const;

export function useMe() {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: () => apiFetch('/api/me', meResponseSchema),
    staleTime: 60_000,
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.code === 'auth/unauthenticated') && failureCount < 2,
  });
}

// Auth forms and settings' logout call this after a session-changing
// request so the next render reflects the new signed-in/out state.
export function useInvalidateMe() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: meQueryKey });
}

export function useUpdateMe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateMeInput) =>
      apiFetch('/api/me', meResponseSchema.shape.profile, { method: 'PATCH', body: patch }),
    onSuccess: (profile) => {
      queryClient.setQueryData(meQueryKey, (prev: MeResponse | undefined) =>
        prev ? { ...prev, profile } : prev,
      );
    },
  });
}
