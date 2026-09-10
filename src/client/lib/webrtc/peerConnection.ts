import type { IceServer } from '@shared/calls';
import {
  initialNegotiationState,
  reduceNegotiation,
  type NegotiationCommand,
  type NegotiationState,
  type RemoteDescriptionInput,
} from './negotiation';

// docs/06 §4: mono, 48kHz, browser echo/noise/gain processing — this is the
// one place both sides of a call agree on capture settings.
export function getCallAudioConstraints(deviceId?: string): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 48_000,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
    video: false,
  };
}

const MAX_AUDIO_BITRATE_BPS = 32_000;

// docs/06 §4: "Encoder prefs on sender: `sender.setParameters({
// encodings:[{ maxBitrate: 32_000 }] })`." Best-effort — a sender without a
// track yet (before `addTrack`) can't set encodings; callers apply this
// after adding the local audio track.
export async function applyAudioEncoderPrefs(sender: RTCRtpSender): Promise<void> {
  const params = sender.getParameters();
  params.encodings = params.encodings?.length
    ? params.encodings.map((e) => ({ ...e, maxBitrate: MAX_AUDIO_BITRATE_BPS }))
    : [{ maxBitrate: MAX_AUDIO_BITRATE_BPS }];
  await sender.setParameters(params);
}

export type CallPeerConnectionHandlers = {
  onLocalDescription: (description: RTCSessionDescriptionInit) => void;
  onIceCandidate: (candidate: RTCIceCandidateInit | null) => void;
  onConnectionStateChange: (state: RTCPeerConnectionState) => void;
  onRemoteTrack: (stream: MediaStream) => void;
};

// The impure half of perfect negotiation (docs/10 §3's M13 seed: "React only
// wires it up") — owns exactly one `RTCPeerConnection`, drives
// `reduceNegotiation` off its events, and executes the commands it emits.
// Everything decision-shaped (ignore this offer? buffer this candidate?)
// lives in negotiation.ts; this class only ever does what a command says.
export class CallPeerConnection {
  readonly pc: RTCPeerConnection;
  private negotiation: NegotiationState;
  private readonly handlers: CallPeerConnectionHandlers;

  constructor(iceServers: IceServer[], polite: boolean, handlers: CallPeerConnectionHandlers) {
    this.negotiation = initialNegotiationState(polite);
    this.handlers = handlers;
    this.pc = new RTCPeerConnection({
      iceServers: iceServers as RTCIceServer[],
      // Settings §"Hide my IP" (docs/05 §6) forces this to 'relay' from the
      // caller of `createCallPeerConnection` instead — plain 'all' here.
      iceTransportPolicy: 'all',
    });

    this.pc.onnegotiationneeded = () => {
      void this.dispatch({ type: 'negotiationneeded' });
    };
    this.pc.onicecandidate = (event) => {
      this.handlers.onIceCandidate(event.candidate ? event.candidate.toJSON() : null);
    };
    this.pc.onsignalingstatechange = () => {
      this.dispatchSync({ type: 'signalingStateChange', state: this.pc.signalingState });
    };
    this.pc.onconnectionstatechange = () => {
      this.handlers.onConnectionStateChange(this.pc.connectionState);
    };
    this.pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) this.handlers.onRemoteTrack(stream);
    };
  }

  private dispatchSync(
    event: Parameters<typeof reduceNegotiation>[1],
  ): NegotiationCommand[] {
    const { state, commands } = reduceNegotiation(this.negotiation, event);
    this.negotiation = state;
    return commands;
  }

  private async dispatch(event: Parameters<typeof reduceNegotiation>[1]): Promise<void> {
    const commands = this.dispatchSync(event);
    try {
      for (const command of commands) await this.runCommand(command);
    } finally {
      if (event.type === 'negotiationneeded') {
        this.dispatchSync({ type: 'negotiationSettled' });
      }
    }
  }

  private async runCommand(command: NegotiationCommand): Promise<void> {
    switch (command.cmd) {
      case 'setLocalDescriptionAndSend':
        await this.pc.setLocalDescription();
        if (this.pc.localDescription) this.handlers.onLocalDescription(this.pc.localDescription.toJSON());
        return;
      case 'setRemoteDescription':
        await this.pc.setRemoteDescription(command.description);
        return;
      case 'addIceCandidate':
        try {
          await this.pc.addIceCandidate(command.candidate ?? undefined);
        } catch (err) {
          if (!this.negotiation.ignoreOffer) throw err;
        }
        return;
    }
  }

  // Signal-frame entry points — callSession.ts calls these as `offer`/
  // `answer`/`ice` frames arrive. The wire type allows the full
  // `RTCSdpType` union (`pranswer`/`rollback` included, for schema
  // symmetry); callers only ever construct these from an `offer`/`answer`
  // frame, so the narrower `RemoteDescriptionInput` here is a type-level
  // bridge, not a runtime check.
  onRemoteOffer(sdp: RTCSessionDescriptionInit): Promise<void> {
    return this.dispatch({ type: 'remoteDescription', description: sdp as RemoteDescriptionInput });
  }

  onRemoteAnswer(sdp: RTCSessionDescriptionInit): Promise<void> {
    return this.dispatch({ type: 'remoteDescription', description: sdp as RemoteDescriptionInput });
  }

  onRemoteIceCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    return this.dispatch({ type: 'remoteIceCandidate', candidate });
  }

  close(): void {
    for (const sender of this.pc.getSenders()) sender.track?.stop();
    for (const receiver of this.pc.getReceivers()) receiver.track?.stop();
    this.pc.close();
  }
}
