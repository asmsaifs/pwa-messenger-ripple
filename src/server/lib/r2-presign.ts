import { AwsClient } from 'aws4fetch';
import type { Env } from '../env';

// R2's S3-compatible API is the only way to hand a browser a presigned
// PUT/GET (docs/01 §4.2, docs/05 §7) — the `R2Bucket` binding itself has no
// presign method, only get/put/head/delete from *inside* the Worker. Signing
// is pure SigV4 crypto (`AwsClient.sign` with `signQuery: true`) — it never
// makes a network call itself, so it works the same against a real bucket or
// the local Miniflare simulator (docs/08 §1).
function r2Client(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
}

function objectUrl(env: Env, key: string): URL {
  return new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.MEDIA_BUCKET_NAME}/${key}`,
  );
}

const PUT_TTL_SECONDS = 15 * 60; // docs/05 §7
const GET_TTL_SECONDS = 60 * 60; // docs/05 §7

// Scoped to one exact key, method, and content-length (docs/05 §7) — a
// replayed URL cannot be reused for a different key, and R2 rejects a PUT
// whose body size doesn't match `Content-Length` if the client lies about it.
export async function presignPutUrl(
  env: Env,
  key: string,
  contentLength: number,
): Promise<{ url: string; expiresAt: number }> {
  const url = objectUrl(env, key);
  url.searchParams.set('X-Amz-Expires', String(PUT_TTL_SECONDS));
  const signed = await r2Client(env).sign(
    new Request(url, { method: 'PUT', headers: { 'Content-Length': String(contentLength) } }),
    { aws: { signQuery: true } },
  );
  return { url: signed.url, expiresAt: Date.now() + PUT_TTL_SECONDS * 1000 };
}

export async function presignGetUrl(
  env: Env,
  key: string,
): Promise<{ url: string; expiresAt: number }> {
  const url = objectUrl(env, key);
  url.searchParams.set('X-Amz-Expires', String(GET_TTL_SECONDS));
  const signed = await r2Client(env).sign(new Request(url, { method: 'GET' }), {
    aws: { signQuery: true },
  });
  return { url: signed.url, expiresAt: Date.now() + GET_TTL_SECONDS * 1000 };
}
