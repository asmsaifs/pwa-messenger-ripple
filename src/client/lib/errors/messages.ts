import type { ClientErrorCode } from '../api';

// docs/03 §6: "Each [code] maps to exactly one user-facing string ... Raw
// server messages never reach the UI." This is that map — every call site
// renders `messageForErrorCode(err.code)`, never `err.message`.
const MESSAGES: Record<ClientErrorCode, string> = {
  'auth/unauthenticated': 'Please sign in to continue.',
  'auth/unverified-email': 'Please verify your email to continue.',
  'auth/invalid-credentials': 'Incorrect email or password.',
  'auth/csrf': 'Your session expired — reload the page and try again.',
  'validation/invalid': "That didn't look right — check the form and try again.",
  'policy/forbidden': "You don't have access to that.",
  'policy/not-found': "That doesn't exist, or isn't visible to you.",
  'policy/blocked': "You can't do that with this person.",
  'rate/limited': "You're doing that too often — try again later.",
  'net/offline': "You're offline — this will retry once you're back online.",
  'net/timeout': 'The request timed out. Try again.',
  'media/permission-denied': 'Microphone or camera access was denied.',
  'media/no-device': 'No microphone or camera was found.',
  'media/in-use': 'Your microphone or camera is being used by another app.',
  'call/busy': "They're already on another call.",
  'call/timeout': "They didn't answer.",
  'call/ice-failed': "Couldn't connect the call.",
  'call/peer-left': 'The other person left the call.',
  'upload/too-large': "That file is too large.",
  'upload/unsupported-type': "That file type isn't supported.",
  'upload/quota': "You're out of storage space.",
  'upload/mismatch': "That file didn't upload correctly — try again.",
  'ws/stale-seq': 'Catching up on missed messages…',
  'ws/backpressure': 'Connection is busy — try again in a moment.',
  internal: 'Something went wrong on our end.',
};

export function messageForErrorCode(code: ClientErrorCode): string {
  return MESSAGES[code];
}
