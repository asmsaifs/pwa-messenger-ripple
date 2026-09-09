// Invite token generation/hashing (docs/02 §1: "raw never stored or logged",
// only `sha256(raw)` lives in `invitations.token_hash`). Web Crypto only —
// available in Workers, no extra dependency.
const RAW_BYTES = 32;

export function generateInviteToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RAW_BYTES));
  return bytesToHex(bytes);
}

export async function hashInviteToken(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
