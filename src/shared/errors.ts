import { z } from 'zod';

// Shared AppError codes — docs/03 §6. Every failure response uses one of
// these; raw server messages never reach the UI (src/client/lib/errors/messages.ts
// maps each code to exactly one user-facing string).
export const APP_ERROR_CODES = [
  'auth/unauthenticated',
  'auth/unverified-email',
  'auth/invalid-credentials',
  'auth/csrf',
  'validation/invalid',
  'policy/forbidden',
  'policy/not-found',
  'policy/blocked',
  'rate/limited',
  'net/offline',
  'net/timeout',
  'media/permission-denied',
  'media/no-device',
  'media/in-use',
  'call/busy',
  'call/timeout',
  'call/ice-failed',
  'call/peer-left',
  'upload/too-large',
  'upload/unsupported-type',
  'upload/quota',
  'upload/mismatch',
  'ws/stale-seq',
  'ws/backpressure',
  'account/deletion-pending',
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

// Envelope: success `200 { data }`; failure `4xx/5xx { error: { code, message, details? } }`
// (docs/03 top). Imported by both the route (serialize) and the client (parse).
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.enum(APP_ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
