import { create } from 'zustand';
import type { PublicProfile } from '@shared/user-events';

// Global call status (docs/10 §5 anti-pattern list: "Storing WebRTC objects
// in React state ... use refs + a Zustand store for status only"). This
// store holds only serializable UI state — the `RTCPeerConnection`,
// `WebSocket`, and `MediaStream` live in refs inside
// src/client/lib/webrtc/callSession.ts, which is what writes here. Reading
// this from both `CallPage` and `CallMinimizedBar` is what lets navigating
// away from `/call/:id` keep the call alive (docs/04 §"Minimized": "rendered
// from a global call store so navigation never tears down the
// RTCPeerConnection").
export type CallUiStatus =
  | 'idle'
  | 'outgoing-ringing'
  | 'incoming-ringing'
  | 'connecting'
  | 'active'
  | 'ended';

export type NetworkQuality = 'good' | 'fair' | 'poor' | null;

export type CallState = {
  status: CallUiStatus;
  callId: string | null;
  conversationId: string | null;
  peer: PublicProfile | null;
  direction: 'outgoing' | 'incoming' | null;
  startedAt: number | null;
  endedLabel: string | null; // "Call ended · 0:32" / "Declined" / "No answer" / "Connection failed"
  muted: boolean;
  networkQuality: NetworkQuality;
  errorCode: string | null;
};

const initialState: CallState = {
  status: 'idle',
  callId: null,
  conversationId: null,
  peer: null,
  direction: null,
  startedAt: null,
  endedLabel: null,
  muted: false,
  networkQuality: null,
  errorCode: null,
};

export const useCallStore = create<CallState>(() => initialState);

export function resetCallStore(): void {
  useCallStore.setState(initialState);
}
