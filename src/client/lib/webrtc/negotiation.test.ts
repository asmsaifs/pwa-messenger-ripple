import { describe, expect, it } from 'vitest';
import { initialNegotiationState, reduceNegotiation } from './negotiation';

describe('reduceNegotiation', () => {
  it('negotiationneeded sets makingOffer and emits setLocalDescriptionAndSend', () => {
    const { state, commands } = reduceNegotiation(initialNegotiationState(false), {
      type: 'negotiationneeded',
    });
    expect(state.makingOffer).toBe(true);
    expect(commands).toEqual([{ cmd: 'setLocalDescriptionAndSend' }]);
  });

  it('negotiationSettled clears makingOffer (the "finally" step)', () => {
    const making = reduceNegotiation(initialNegotiationState(false), {
      type: 'negotiationneeded',
    }).state;
    const { state, commands } = reduceNegotiation(making, { type: 'negotiationSettled' });
    expect(state.makingOffer).toBe(false);
    expect(commands).toEqual([]);
  });

  it('accepts a remote offer while idle (stable, not making an offer)', () => {
    const { state, commands } = reduceNegotiation(initialNegotiationState(true), {
      type: 'remoteDescription',
      description: { type: 'offer', sdp: 'o=...' },
    });
    expect(state.ignoreOffer).toBe(false);
    expect(state.isSettingRemoteAnswerPending).toBe(false);
    expect(commands).toEqual([
      { cmd: 'setRemoteDescription', description: { type: 'offer', sdp: 'o=...' } },
      { cmd: 'setLocalDescriptionAndSend' },
    ]);
  });

  it('an answer sets isSettingRemoteAnswerPending and does not create a local description', () => {
    const { state, commands } = reduceNegotiation(initialNegotiationState(false), {
      type: 'remoteDescription',
      description: { type: 'answer', sdp: 'a=...' },
    });
    expect(state.isSettingRemoteAnswerPending).toBe(true);
    expect(commands).toEqual([
      { cmd: 'setRemoteDescription', description: { type: 'answer', sdp: 'a=...' } },
    ]);
  });

  it('glare: the impolite peer ignores an incoming offer while making its own', () => {
    const makingOffer = reduceNegotiation(initialNegotiationState(false), {
      type: 'negotiationneeded',
    }).state;
    const { state, commands } = reduceNegotiation(makingOffer, {
      type: 'remoteDescription',
      description: { type: 'offer', sdp: 'o=...' },
    });
    expect(state.ignoreOffer).toBe(true);
    expect(commands).toEqual([]);
  });

  it('glare: the polite peer accepts an incoming offer even while making its own', () => {
    const makingOffer = reduceNegotiation(initialNegotiationState(true), {
      type: 'negotiationneeded',
    }).state;
    const { state, commands } = reduceNegotiation(makingOffer, {
      type: 'remoteDescription',
      description: { type: 'offer', sdp: 'o=...' },
    });
    expect(state.ignoreOffer).toBe(false);
    expect(commands.map((c) => c.cmd)).toEqual(['setRemoteDescription', 'setLocalDescriptionAndSend']);
  });

  it('an ignored offer causes a subsequent ICE candidate to be dropped, not attempted', () => {
    const makingOffer = reduceNegotiation(initialNegotiationState(false), {
      type: 'negotiationneeded',
    }).state;
    const afterCollision = reduceNegotiation(makingOffer, {
      type: 'remoteDescription',
      description: { type: 'offer', sdp: 'o=...' },
    }).state;
    expect(afterCollision.ignoreOffer).toBe(true);

    const { commands } = reduceNegotiation(afterCollision, {
      type: 'remoteIceCandidate',
      candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
    });
    expect(commands).toEqual([]);
  });

  it('a normal ICE candidate is passed through as addIceCandidate, including end-of-candidates null', () => {
    const state = initialNegotiationState(true);
    expect(
      reduceNegotiation(state, {
        type: 'remoteIceCandidate',
        candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
      }).commands,
    ).toEqual([
      { cmd: 'addIceCandidate', candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } },
    ]);
    expect(reduceNegotiation(state, { type: 'remoteIceCandidate', candidate: null }).commands).toEqual([
      { cmd: 'addIceCandidate', candidate: null },
    ]);
  });

  it('signalingStateChange only tracks state, no commands', () => {
    const { state, commands } = reduceNegotiation(initialNegotiationState(false), {
      type: 'signalingStateChange',
      state: 'have-local-offer',
    });
    expect(state.signalingState).toBe('have-local-offer');
    expect(commands).toEqual([]);
  });

  it('an offer arriving right after isSettingRemoteAnswerPending is still ready-for-offer', () => {
    // Simulates: we sent an offer, haven't gotten stable yet, but we're
    // mid-way through applying a remote answer — still a valid moment to
    // accept a fresh incoming offer per the spec's `readyForOffer` check.
    const pendingAnswer: ReturnType<typeof initialNegotiationState> = {
      ...initialNegotiationState(false),
      signalingState: 'have-local-offer',
      isSettingRemoteAnswerPending: true,
    };
    const { state, commands } = reduceNegotiation(pendingAnswer, {
      type: 'remoteDescription',
      description: { type: 'offer', sdp: 'o=...' },
    });
    expect(state.ignoreOffer).toBe(false);
    expect(commands.map((c) => c.cmd)).toEqual(['setRemoteDescription', 'setLocalDescriptionAndSend']);
  });
});
