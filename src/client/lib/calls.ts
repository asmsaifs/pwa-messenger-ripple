import {
  callDetailResponseSchema,
  createCallResponseSchema,
  turnResponseSchema,
  type CallDetailResponse,
  type CreateCallResponse,
  type TurnResponse,
} from '@shared/calls';
import { z } from 'zod';
import { apiFetch } from './api';

// docs/03 §1. Module-level functions, not query hooks — callSession.ts
// drives these outside React, same rationale as push.ts.
export async function startCall(conversationId: string): Promise<CreateCallResponse> {
  return apiFetch('/api/calls', createCallResponseSchema, {
    method: 'POST',
    body: { conversationId },
  });
}

export async function declineCall(callId: string): Promise<void> {
  await apiFetch<void>(`/api/calls/${callId}/decline`, z.void(), { method: 'POST' });
}

export async function fetchTurnCredentials(): Promise<TurnResponse> {
  return apiFetch('/api/turn', turnResponseSchema);
}

export async function fetchCallDetail(callId: string): Promise<CallDetailResponse> {
  return apiFetch(`/api/calls/${callId}`, callDetailResponseSchema);
}
