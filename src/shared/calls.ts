import { z } from 'zod';
import { publicProfileSchema } from './user-events';

// Voice calls (docs/01 §4.3, docs/03 §1/§2.3/§3, docs/09 M13) — REST +
// `CallDO` WS protocol, shared by the route/DO (validation) and the client
// (types + parsing), same convention as every other src/shared module
// (CLAUDE.md rule 5).

// D1's `calls.status` enum (docs/02 §1's CHECK constraint) — the persisted,
// terminal-or-ringing-or-active set.
export const callStatusSchema = z.enum([
  'ringing',
  'active',
  'ended',
  'missed',
  'declined',
  'failed',
]);
export type CallStatus = z.infer<typeof callStatusSchema>;

// CallDO's live in-memory/KV state machine adds `connecting` (docs/03 §2.3's
// diagram: `ringing --accept--> connecting --peer 'connected'--> active`) —
// a transient step D1 never needs to durably record, so it's not part of
// `callStatusSchema`/the D1 CHECK constraint, only the WS wire protocol's
// `state` frame below.
export const callLiveStatusSchema = z.union([callStatusSchema, z.literal('connecting')]);
export type CallLiveStatus = z.infer<typeof callLiveStatusSchema>;

export const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof iceServerSchema>;

// ── REST ────────────────────────────────────────────────────────────────
// `POST /api/calls { conversationId } → { callId, wsUrl, iceServers }`
// (docs/03 §1). `calleeId` is resolved server-side from the conversation's
// peer membership — never trusted as client input (policy.assertCanStartCall).
export const createCallSchema = z.object({ conversationId: z.string().min(1) });
export type CreateCallInput = z.infer<typeof createCallSchema>;

export const createCallResponseSchema = z.object({
  callId: z.string(),
  wsUrl: z.string(),
  iceServers: z.array(iceServerSchema),
});
export type CreateCallResponse = z.infer<typeof createCallResponseSchema>;

export const callSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  callerId: z.string(),
  calleeId: z.string(),
  status: callStatusSchema,
  startedAt: z.number().int().nullable(),
  endedAt: z.number().int().nullable(),
  endReason: z.string().nullable(),
  iceRelayed: z.boolean().nullable(),
  createdAt: z.number().int(),
});
export type Call = z.infer<typeof callSchema>;

export const listCallsResponseSchema = z.object({ calls: z.array(callSchema) });
export type ListCallsResponse = z.infer<typeof listCallsResponseSchema>;

// `GET /api/calls/:id → { call, peer, direction }` (docs/03 §1 addendum) —
// cold-start hydration for a client that has no WS-populated `callStore` yet
// (e.g. a PWA launched fresh from a push notification's Accept action, which
// never received the `incoming_call` UserDO frame the ringing screen
// normally comes from). `direction` is resolved server-side from the
// session actor, never trusted from the client.
export const callDetailResponseSchema = z.object({
  call: callSchema,
  peer: publicProfileSchema,
  direction: z.enum(['caller', 'callee']),
});
export type CallDetailResponse = z.infer<typeof callDetailResponseSchema>;

// `GET /api/turn → { iceServers, ttlSeconds }` (docs/03 §1) — Cloudflare
// Realtime TURN credentials minted server-side, 1h TTL, cached client-side
// for `ttl-300`s (docs/01 §4.3).
export const turnResponseSchema = z.object({
  iceServers: z.array(iceServerSchema),
  ttlSeconds: z.number().int().positive(),
});
export type TurnResponse = z.infer<typeof turnResponseSchema>;

// ── `CallDO` WS protocol — `/api/ws/call/:callId` (docs/03 §2.3, verbatim) ──
const rtcSessionDescriptionSchema = z.object({
  type: z.enum(['offer', 'answer', 'pranswer', 'rollback']),
  sdp: z.string().optional(),
});

const rtcIceCandidateSchema = z.object({
  candidate: z.string(),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().nullable().optional(),
  usernameFragment: z.string().nullable().optional(),
});

// Client → server (and, with `from` added by the DO, server → client relay).
export const callSignalFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('offer'), sdp: rtcSessionDescriptionSchema }),
  z.object({ t: z.literal('answer'), sdp: rtcSessionDescriptionSchema }),
  z.object({ t: z.literal('ice'), candidate: rtcIceCandidateSchema.nullable() }),
  z.object({ t: z.literal('accept') }),
  z.object({ t: z.literal('decline'), reason: z.enum(['busy', 'user']) }),
  z.object({ t: z.literal('bye'), reason: z.string() }),
  z.object({
    t: z.literal('stats'),
    relayed: z.boolean(),
    rttMs: z.number().nonnegative(),
    lossPct: z.number().nonnegative(),
  }),
  z.object({ t: z.literal('ping') }),
]);
export type CallSignalFrame = z.infer<typeof callSignalFrameSchema>;

// Server → client only: every relayed frame plus `from`, and the two frames
// the DO originates itself (state transitions clients render but don't
// decide — docs/03 §2.3).
export const callServerFrameSchema = z.union([
  z.intersection(callSignalFrameSchema, z.object({ from: z.string() })),
  z.object({ t: z.literal('state'), status: callLiveStatusSchema }),
  z.object({ t: z.literal('error'), code: z.string(), message: z.string() }),
  z.object({ t: z.literal('pong') }),
]);
export type CallServerFrame = z.infer<typeof callServerFrameSchema>;
