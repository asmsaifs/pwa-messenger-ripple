// Perfect negotiation (docs/01 §4.3, docs/03 §2.3, docs/10 §3's M13 seed:
// "Implement perfect negotiation ... as a pure reducer in
// src/client/lib/webrtc/, testable without a real RTCPeerConnection; React
// only wires it up"). This is the WHATWG pattern
// (https://w3c.github.io/webrtc-pc/#perfect-negotiation-example) restated as
// a pure `(state, event) -> { state, commands }` reducer: the *decisions*
// (ignore this offer? buffer this candidate? who negotiates next?) are pure
// and unit-testable here; `peerConnection.ts` is the thin impure layer that
// executes the emitted commands against a real `RTCPeerConnection` and feeds
// results back in as further events.
//
// caller polite=false, callee polite=true (docs/03 §2.3, verbatim).

export type NegotiationState = {
  readonly polite: boolean;
  readonly makingOffer: boolean;
  readonly ignoreOffer: boolean;
  readonly isSettingRemoteAnswerPending: boolean;
  readonly signalingState: RTCSignalingState;
};

export function initialNegotiationState(polite: boolean): NegotiationState {
  return {
    polite,
    makingOffer: false,
    ignoreOffer: false,
    isSettingRemoteAnswerPending: false,
    signalingState: 'stable',
  };
}

export type RemoteDescriptionInput = { type: 'offer' | 'answer'; sdp?: string };

export type NegotiationEvent =
  // `RTCPeerConnection.onnegotiationneeded` fired — local media/tracks
  // changed and an offer is needed.
  | { type: 'negotiationneeded' }
  // The impure layer's async negotiate-and-send block finished (success or
  // error) — mirrors the original snippet's `finally { makingOffer = false }`.
  | { type: 'negotiationSettled' }
  // A `{t:'offer'}` or `{t:'answer'}` signal frame arrived from the peer.
  | { type: 'remoteDescription'; description: RemoteDescriptionInput }
  // A `{t:'ice'}` signal frame arrived (`null` candidate = end-of-candidates,
  // still worth attempting per the spec — `addIceCandidate(null)` is valid).
  | { type: 'remoteIceCandidate'; candidate: RTCIceCandidateInit | null }
  // `RTCPeerConnection.onsignalingstatechange` fired.
  | { type: 'signalingStateChange'; state: RTCSignalingState };

export type NegotiationCommand =
  // Create + set the local description (offer or, mid-remote-offer-handling,
  // answer) and send it to the peer over the signaling channel. One command
  // because the impure layer's `pc.setLocalDescription()` (no args) already
  // decides offer-vs-answer from `pc.signalingState`.
  | { cmd: 'setLocalDescriptionAndSend' }
  | { cmd: 'setRemoteDescription'; description: RemoteDescriptionInput }
  | { cmd: 'addIceCandidate'; candidate: RTCIceCandidateInit | null };

export type NegotiationResult = { state: NegotiationState; commands: NegotiationCommand[] };

export function reduceNegotiation(
  state: NegotiationState,
  event: NegotiationEvent,
): NegotiationResult {
  switch (event.type) {
    case 'negotiationneeded':
      // The original snippet re-enters unconditionally (try/finally) — a
      // second `negotiationneeded` while one is already in flight is rare in
      // practice (one per track/transceiver change) and browsers coalesce
      // most cases; matching the spec's own handler rather than adding
      // reentrancy guards it doesn't have.
      return {
        state: { ...state, makingOffer: true },
        commands: [{ cmd: 'setLocalDescriptionAndSend' }],
      };

    case 'negotiationSettled':
      return { state: { ...state, makingOffer: false }, commands: [] };

    case 'remoteDescription': {
      const readyForOffer =
        !state.makingOffer &&
        (state.signalingState === 'stable' || state.isSettingRemoteAnswerPending);
      const offerCollision = event.description.type === 'offer' && !readyForOffer;
      const ignoreOffer = !state.polite && offerCollision;

      if (ignoreOffer) {
        return { state: { ...state, ignoreOffer: true }, commands: [] };
      }

      const isSettingRemoteAnswerPending = event.description.type === 'answer';
      const commands: NegotiationCommand[] = [
        { cmd: 'setRemoteDescription', description: event.description },
      ];
      // "if (description.type === 'offer') { await setLocalDescription();
      // send(...) }" — issued alongside `setRemoteDescription` since the
      // impure layer runs commands in order, awaiting each.
      if (event.description.type === 'offer') {
        commands.push({ cmd: 'setLocalDescriptionAndSend' });
      }
      return {
        state: { ...state, ignoreOffer: false, isSettingRemoteAnswerPending },
        commands,
      };
    }

    case 'remoteIceCandidate':
      // "catch (err) { if (!ignoreOffer) throw err }" — an ignored offer's
      // ICE is expected to fail against a description that was never set;
      // simplify to not attempting it at all rather than attempt-then-swallow.
      if (state.ignoreOffer) return { state, commands: [] };
      return { state, commands: [{ cmd: 'addIceCandidate', candidate: event.candidate }] };

    case 'signalingStateChange':
      return { state: { ...state, signalingState: event.state }, commands: [] };
  }
}
