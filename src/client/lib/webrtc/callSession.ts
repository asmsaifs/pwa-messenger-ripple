import type { PublicProfile } from '@shared/user-events';
import type { CallServerFrame, CallSignalFrame } from '@shared/calls';
import { declineCall, fetchTurnCredentials, startCall } from '../calls';
import { connectCallSocket, type CallSocketHandle } from '../ws/callSocket';
import { getCallAudioConstraints, applyAudioEncoderPrefs, CallPeerConnection } from './peerConnection';
import { useCallStore, resetCallStore } from '../../store/callStore';
import { messageForErrorCode } from '../errors/messages';
import { ApiError } from '../api';

// Module-level singleton (docs/10 §5 anti-pattern list, docs/04
// §"Minimized") — owns the one `RTCPeerConnection`/`WebSocket`/
// `MediaStream` for the lifetime of a call, independent of which route is
// mounted, so navigating from `/call/:id` to `/chats` and back never tears
// down the connection. `useCallStore` is the only thing components read.

let socket: CallSocketHandle | null = null;
let peerConnection: CallPeerConnection | null = null;
let localStream: MediaStream | null = null;
let wakeLock: WakeLockSentinel | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
export let remoteStream: MediaStream | null = null;
let onRemoteStreamChange: ((stream: MediaStream | null) => void) | null = null;

export function subscribeRemoteStream(cb: (stream: MediaStream | null) => void): () => void {
  onRemoteStreamChange = cb;
  cb(remoteStream);
  return () => {
    if (onRemoteStreamChange === cb) onRemoteStreamChange = null;
  };
}

function setRemoteStream(stream: MediaStream | null): void {
  remoteStream = stream;
  onRemoteStreamChange?.(stream);
}

// docs/06 §3: lid close / tab hidden during a call must not suspend audio —
// re-acquired on `visibilitychange` since a lock releases automatically once
// the tab is hidden.
async function acquireWakeLock(): Promise<void> {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch {
    // Best-effort — a denied/unsupported wake lock must not block the call.
  }
}

function releaseWakeLock(): void {
  void wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function handleVisibilityChange(): void {
  if (document.visibilityState === 'visible' && useCallStore.getState().status === 'active') {
    void acquireWakeLock();
  }
}

// docs/04 §"Active": "Network-quality chip from getStats() (packetsLost,
// jitter, rtt): Good/Fair/Poor."
function classifyQuality(lossPct: number, rttMs: number): 'good' | 'fair' | 'poor' {
  if (lossPct > 8 || rttMs > 400) return 'poor';
  if (lossPct > 2 || rttMs > 200) return 'fair';
  return 'good';
}

// `RTCStatsReport` is a `Map<string, any>` in lib.dom — this is the narrow
// shape this module actually reads off the reports it cares about, given an
// explicit type so `.forEach` callbacks below aren't operating on `any`.
type CallStatsReport = {
  type: string;
  state?: string;
  packetsLost?: number;
  packetsReceived?: number;
  currentRoundTripTime?: number;
  localCandidateId?: string;
  candidateType?: string;
};

async function pollStats(): Promise<void> {
  const pc = peerConnection?.pc;
  if (!pc) return;
  const stats = await pc.getStats();
  let packetsLost = 0;
  let packetsReceived = 0;
  let rttMs = 0;
  stats.forEach((report: CallStatsReport) => {
    if (report.type === 'inbound-rtp') {
      packetsLost += report.packetsLost ?? 0;
      packetsReceived += report.packetsReceived ?? 0;
    }
    if (report.type === 'candidate-pair' && report.state === 'succeeded') {
      rttMs = (report.currentRoundTripTime ?? 0) * 1000;
    }
  });
  const total = packetsLost + packetsReceived;
  const lossPct = total > 0 ? (packetsLost / total) * 100 : 0;
  useCallStore.setState({ networkQuality: classifyQuality(lossPct, rttMs) });
}

function cleanup(): void {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  releaseWakeLock();
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  socket?.close();
  socket = null;
  peerConnection?.close();
  peerConnection = null;
  for (const track of localStream?.getTracks() ?? []) track.stop();
  localStream = null;
  setRemoteStream(null);
}

function endWithLabel(label: string, errorCode: string | null = null): void {
  cleanup();
  useCallStore.setState({ status: 'ended', endedLabel: label, errorCode });
}

async function reportStatsAndBye(reason: string): Promise<void> {
  const pc = peerConnection?.pc;
  if (pc && socket) {
    try {
      const stats = await pc.getStats();
      const lossPct = 0;
      let rttMs = 0;
      let localCandidateId: string | undefined;
      stats.forEach((report: CallStatsReport) => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          rttMs = (report.currentRoundTripTime ?? 0) * 1000;
          localCandidateId = report.localCandidateId;
        }
      });
      // "relayed" means the succeeded pair's *local* candidate went through
      // TURN (docs/07 §8's "relay share" metric) — not merely that the pair
      // has a localCandidateId, which every succeeded pair does.
      const relayed = localCandidateId
        ? (stats.get(localCandidateId) as CallStatsReport | undefined)?.candidateType === 'relay'
        : false;
      socket.send({ t: 'stats', relayed, rttMs, lossPct });
    } catch {
      // best-effort
    }
  }
  socket?.send({ t: 'bye', reason });
}

// Wire ↔ DOM boundary: the zod-inferred `ice` frame shape and the browser's
// `RTCIceCandidateInit` differ only in which fields
// `exactOptionalPropertyTypes` treats as "omittable" vs. "explicitly
// undefined" — structurally identical on the wire either way, so this is a
// type-level bridge only, not a runtime reshape.
function iceFrame(candidate: RTCIceCandidateInit | null): CallSignalFrame {
  return { t: 'ice', candidate } as CallSignalFrame;
}

function setupPeerConnection(
  iceServers: ConstructorParameters<typeof CallPeerConnection>[0],
  polite: boolean,
): void {
  peerConnection = new CallPeerConnection(iceServers, polite, {
    onLocalDescription: (description) => {
      socket?.send(
        description.type === 'offer' ? { t: 'offer', sdp: description } : { t: 'answer', sdp: description },
      );
    },
    onIceCandidate: (candidate) => socket?.send(iceFrame(candidate)),
    onConnectionStateChange: (state) => {
      if (state === 'connected') {
        useCallStore.setState({ status: 'active', startedAt: useCallStore.getState().startedAt ?? Date.now() });
        void acquireWakeLock();
        document.addEventListener('visibilitychange', handleVisibilityChange);
        statsTimer = setInterval(() => void pollStats(), 3_000);
      } else if (state === 'failed') {
        endWithLabel('Connection failed', 'call/ice-failed');
      }
    },
    onRemoteTrack: (stream) => setRemoteStream(stream),
  });
}

function handleServerFrame(frame: CallServerFrame): void {
  switch (frame.t) {
    case 'offer':
      void peerConnection?.onRemoteOffer(frame.sdp as RTCSessionDescriptionInit);
      return;
    case 'answer':
      void peerConnection?.onRemoteAnswer(frame.sdp as RTCSessionDescriptionInit);
      return;
    case 'ice':
      void peerConnection?.onRemoteIceCandidate(frame.candidate as RTCIceCandidateInit | null);
      return;
    case 'accept':
      useCallStore.setState({ status: 'connecting' });
      return;
    case 'decline':
      endWithLabel('Declined');
      return;
    case 'bye':
      endWithLabel(
        useCallStore.getState().startedAt
          ? `Call ended · ${formatDuration((Date.now() - (useCallStore.getState().startedAt ?? Date.now())) / 1000)}`
          : 'Call ended',
      );
      return;
    case 'state':
      if (frame.status === 'connecting') useCallStore.setState({ status: 'connecting' });
      if (frame.status === 'missed') endWithLabel('No answer');
      if (frame.status === 'declined') endWithLabel('Declined');
      if (frame.status === 'failed') endWithLabel('Connection failed', 'call/ice-failed');
      return;
    case 'error':
    case 'pong':
      return;
  }
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

async function acquireMicrophone(deviceId?: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(getCallAudioConstraints(deviceId));
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    if (name === 'NotFoundError') throw new ApiError('media/no-device', messageForErrorCode('media/no-device'));
    if (name === 'NotReadableError') throw new ApiError('media/in-use', messageForErrorCode('media/in-use'));
    throw new ApiError('media/permission-denied', messageForErrorCode('media/permission-denied'));
  }
}

// ── Outgoing (docs/01 §4.3: caller is `polite=false`) ──────────────────────
export async function startOutgoingCall(conversationId: string, peer: PublicProfile): Promise<void> {
  if (useCallStore.getState().status !== 'idle') return; // one call at a time client-side too
  resetCallStore();
  useCallStore.setState({
    status: 'outgoing-ringing',
    direction: 'outgoing',
    conversationId,
    peer,
  });
  try {
    const [{ callId, iceServers }, stream] = await Promise.all([
      startCall(conversationId),
      acquireMicrophone(),
    ]);
    localStream = stream;
    useCallStore.setState({ callId });
    setupPeerConnection(iceServers, false);
    for (const track of stream.getTracks()) {
      const sender = peerConnection!.pc.addTrack(track, stream);
      void applyAudioEncoderPrefs(sender);
    }
    socket = connectCallSocket(callId, {
      onFrame: handleServerFrame,
      onClose: () => {
        if (useCallStore.getState().status !== 'ended') endWithLabel('Connection failed', 'call/ice-failed');
      },
    });
  } catch (err) {
    const code = err instanceof ApiError ? err.code : 'call/ice-failed';
    endWithLabel(messageForErrorCode(code), code);
  }
}

// ── Incoming (docs/03 §2.2's `incoming_call` UserDO frame; callee is
// `polite=true`) — invoked from useUserSocket's message handler. ───────────
export function handleIncomingCall(input: { callId: string; conversationId: string; from: PublicProfile }): void {
  if (useCallStore.getState().status !== 'idle') return; // already on a call — server-side busy check covers the caller's view of this
  resetCallStore();
  useCallStore.setState({
    status: 'incoming-ringing',
    direction: 'incoming',
    callId: input.callId,
    conversationId: input.conversationId,
    peer: input.from,
  });
}

export function handleCallCancelledFromServer(callId: string): void {
  if (useCallStore.getState().callId !== callId) return;
  if (useCallStore.getState().status === 'incoming-ringing') {
    endWithLabel('Missed call');
  }
}

export async function acceptIncomingCall(): Promise<void> {
  const { callId } = useCallStore.getState();
  if (!callId) return;
  try {
    const [stream, { iceServers }] = await Promise.all([acquireMicrophone(), fetchTurnCredentials()]);
    localStream = stream;
    setupPeerConnection(iceServers, true);
    for (const track of stream.getTracks()) {
      const sender = peerConnection!.pc.addTrack(track, stream);
      void applyAudioEncoderPrefs(sender);
    }
    socket = connectCallSocket(callId, {
      onFrame: handleServerFrame,
      onClose: () => {
        if (useCallStore.getState().status !== 'ended') endWithLabel('Connection failed', 'call/ice-failed');
      },
    });
    useCallStore.setState({ status: 'connecting' });
    socket.send({ t: 'accept' });
  } catch (err) {
    const code = err instanceof ApiError ? err.code : 'call/ice-failed';
    endWithLabel(messageForErrorCode(code), code);
    if (callId) void declineCall(callId).catch(() => {});
  }
}

export async function declineIncomingCall(): Promise<void> {
  const { callId } = useCallStore.getState();
  cleanup();
  useCallStore.setState({ status: 'ended', endedLabel: 'Declined' });
  if (callId) await declineCall(callId).catch(() => {});
}

export async function hangUp(): Promise<void> {
  const { status, callId, startedAt } = useCallStore.getState();
  if (status === 'outgoing-ringing' && callId) {
    await reportStatsAndBye('cancelled');
    cleanup();
    useCallStore.setState({ status: 'ended', endedLabel: 'Call ended' });
    return;
  }
  await reportStatsAndBye('user');
  const label = startedAt ? `Call ended · ${formatDuration((Date.now() - startedAt) / 1000)}` : 'Call ended';
  cleanup();
  useCallStore.setState({ status: 'ended', endedLabel: label });
}

export function toggleMute(): void {
  const muted = !useCallStore.getState().muted;
  for (const track of localStream?.getAudioTracks() ?? []) track.enabled = !muted;
  useCallStore.setState({ muted });
}

// docs/06 §3: Bluetooth headset swap / output device selection.
// `setSinkId` is Chromium-only — callers should feature-detect before
// offering a picker.
export async function setOutputDevice(audioEl: HTMLAudioElement, deviceId: string): Promise<void> {
  const withSinkId = audioEl as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof withSinkId.setSinkId === 'function') await withSinkId.setSinkId(deviceId);
}

// docs/06 §3: swap the mic mid-call via `replaceTrack`, no renegotiation.
export async function switchInputDevice(deviceId: string): Promise<void> {
  if (!peerConnection || !localStream) return;
  const newStream = await acquireMicrophone(deviceId);
  const [newTrack] = newStream.getAudioTracks();
  if (!newTrack) return;
  const sender = peerConnection.pc.getSenders().find((s) => s.track?.kind === 'audio');
  await sender?.replaceTrack(newTrack);
  for (const track of localStream.getAudioTracks()) track.stop();
  localStream = newStream;
  if (useCallStore.getState().muted) newTrack.enabled = false;
}

export function resetIdleCallState(): void {
  cleanup();
  resetCallStore();
}

// docs/07 §5 E2E #11: "Reload during an active call → call ends cleanly, no
// orphaned mic track." `pagehide` fires reliably on reload/close (unlike
// `beforeunload`, which some browsers skip for a fast reload); `cleanup()`'s
// `track.stop()` calls are synchronous, so the mic indicator clears even
// though the best-effort `bye` send below may not finish its round trip.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    const { status } = useCallStore.getState();
    if (status === 'idle' || status === 'ended') return;
    socket?.send({ t: 'bye', reason: 'reload' });
    cleanup();
  });
}
