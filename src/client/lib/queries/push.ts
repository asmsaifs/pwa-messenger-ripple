import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  disablePush,
  enablePush,
  isPushSubscribed,
  pushPermissionState,
  pushSupported,
  sendTestPush,
} from '../push';

const pushStatusQueryKey = ['push', 'subscribed'] as const;

// Whether *this* browser/device currently holds a subscription — re-derived
// from `PushManager.getSubscription()` rather than trusted client state,
// since the browser (not this app) owns that source of truth and can revoke
// it at any time (permission reset, `pushsubscriptionchange`).
export function usePushSubscribed() {
  return useQuery({
    queryKey: pushStatusQueryKey,
    queryFn: isPushSubscribed,
    enabled: pushSupported(),
    staleTime: 10_000,
  });
}

export function useEnablePush() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: enablePush,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: pushStatusQueryKey }),
  });
}

export function useDisablePush() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: disablePush,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: pushStatusQueryKey }),
  });
}

export function useSendTestPush() {
  return useMutation({ mutationFn: sendTestPush });
}

export { pushPermissionState, pushSupported };
