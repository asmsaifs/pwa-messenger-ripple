import { errorResponseSchema, type AppErrorCode } from '@shared/errors';
import type { z } from 'zod';

// The taxonomy from docs/03 §6, plus the one shape the Worker emits for a
// truly unhandled exception (src/server/index.ts's `onError` fallback), which
// is deliberately outside `AppErrorCode` there — this is the client's mirror
// of that same "not a taxonomy'd failure" case.
export type ClientErrorCode = AppErrorCode | 'internal';

export class ApiError extends Error {
  readonly code: ClientErrorCode;
  readonly details?: unknown;

  constructor(code: ClientErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
}

type ApiInit = Omit<RequestInit, 'body'> & { body?: unknown };

// Thin fetch wrapper shared by every endpoint call. Request/response shapes
// are the zod schemas in src/shared (CLAUDE.md rule 5) — this only owns
// origin-relative fetch, JSON (de)serialization, and turning a failure
// response into an `ApiError` with a taxonomy code the UI can key off of.
export async function apiFetch<T>(
  path: string,
  schema: z.ZodType<T>,
  init: ApiInit = {},
): Promise<T> {
  const hasBody = init.body !== undefined;
  const { body, ...rest } = init;
  void body; // excluded from RequestInit below — it's `unknown`, not `BodyInit`
  const requestInit: RequestInit = {
    ...rest,
    credentials: 'same-origin',
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  };
  if (hasBody) requestInit.body = JSON.stringify(init.body);

  let res: Response;
  try {
    res = await fetch(path, requestInit);
  } catch {
    throw new ApiError('net/offline', "You're offline.");
  }

  if (!res.ok) {
    const json: unknown = await res.json().catch(() => null);
    const parsed = errorResponseSchema.safeParse(json);
    if (parsed.success) {
      throw new ApiError(parsed.data.error.code, parsed.data.error.message, parsed.data.error.details);
    }
    throw new ApiError('internal', `Request failed with status ${res.status}`);
  }

  return schema.parse(await res.json());
}
