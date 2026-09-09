import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppErrorCode, ErrorResponse } from '../shared/errors';

// The one exception the Worker throws for every taxonomy'd failure — policy
// functions, middleware, and routes all throw this instead of a bare Error so
// the top-level handler in index.ts can serialize a consistent envelope
// (docs/03 top) without each call site knowing HTTP status codes.
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: ContentfulStatusCode;
  readonly details?: unknown;

  constructor(code: AppErrorCode, details?: unknown) {
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_FOR_CODE[code];
    this.details = details;
  }
}

const STATUS_FOR_CODE: Record<AppErrorCode, ContentfulStatusCode> = {
  'auth/unauthenticated': 401,
  'auth/unverified-email': 403,
  'auth/invalid-credentials': 401,
  'auth/csrf': 403,
  'validation/invalid': 400,
  'policy/forbidden': 403,
  'policy/not-found': 404,
  'policy/blocked': 403,
  'rate/limited': 429,
  'net/offline': 503,
  'net/timeout': 504,
  'media/permission-denied': 403,
  'media/no-device': 404,
  'media/in-use': 409,
  'call/busy': 409,
  'call/timeout': 408,
  'call/ice-failed': 502,
  'call/peer-left': 409,
  'upload/too-large': 413,
  'upload/unsupported-type': 415,
  'upload/quota': 413,
  'upload/mismatch': 422,
  'ws/stale-seq': 409,
  'ws/backpressure': 429,
};

// Enumeration rule (docs/02 §5): "not visible to you" is always `policy/not-found`,
// never `policy/forbidden`, which would confirm the row exists.
export function notFound(details?: unknown): never {
  throw new AppError('policy/not-found', details);
}

export function forbidden(details?: unknown): never {
  throw new AppError('policy/forbidden', details);
}

export function blocked(details?: unknown): never {
  throw new AppError('policy/blocked', details);
}

export function toErrorResponse(err: AppError): ErrorResponse {
  return { error: { code: err.code, message: err.message, details: err.details } };
}
