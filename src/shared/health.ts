import { z } from 'zod';

// Response shape for GET /api/health — imported by both the route (validation of
// its own output in tests) and the client (typed parsing). See docs/01 §7.
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  env: z.string(),
  timestamp: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
