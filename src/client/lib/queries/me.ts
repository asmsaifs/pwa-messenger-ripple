import { useQuery, useQueryClient } from '@tanstack/react-query';
import { meResponseSchema } from '@shared/me';
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
