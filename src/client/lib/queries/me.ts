import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  meResponseSchema,
  signAvatarResponseSchema,
  type MeResponse,
  type UpdateMeInput,
} from '@shared/me';
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

// Same sign → PUT → complete shape as `uploadAttachment` (src/client/lib/
// attachments.ts) but scoped to the caller's own profile — see
// src/server/routes/me.ts's `/avatar/sign` and `/avatar/complete`.
export function useUploadAvatar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const { uploadUrl, key } = await apiFetch('/api/me/avatar/sign', signAvatarResponseSchema, {
        method: 'POST',
        body: { contentType: file.type || 'application/octet-stream', size: file.size },
      });

      let putRes: Response;
      try {
        putRes = await fetch(uploadUrl, { method: 'PUT', body: file });
      } catch {
        if (!navigator.onLine) throw new ApiError('net/offline', "You're offline.");
        throw new ApiError('upload/mismatch', "That photo didn't upload correctly — try again.");
      }
      if (!putRes.ok) {
        throw new ApiError('upload/mismatch', "That photo didn't upload correctly — try again.");
      }

      return apiFetch('/api/me/avatar/complete', meResponseSchema.shape.profile, {
        method: 'POST',
        body: { key },
      });
    },
    onSuccess: (profile) => {
      queryClient.setQueryData(meQueryKey, (prev: MeResponse | undefined) =>
        prev ? { ...prev, profile } : prev,
      );
    },
  });
}
