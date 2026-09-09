import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Authenticated data — never persisted by the SW (CLAUDE.md rule 10);
      // TanStack Query's in-memory cache is a different, safe kind of cache.
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
