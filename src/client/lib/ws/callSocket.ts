import {
  callServerFrameSchema,
  callSignalFrameSchema,
  type CallServerFrame,
  type CallSignalFrame,
} from '@shared/calls';

// Non-React WS driver for `CallDO` (docs/03 §2.3) — unlike
// useConversationSocket/useUserSocket, this isn't a hook: the call session
// (src/client/lib/webrtc/callSession.ts) is a module-level singleton so the
// socket + RTCPeerConnection survive navigating away from `/call/:id`
// (docs/04 §"Minimized"), which a component-scoped hook can't do.
export type CallSocketHandlers = {
  onFrame: (frame: CallServerFrame) => void;
  onClose: () => void;
};

export type CallSocketHandle = {
  send: (frame: CallSignalFrame) => void;
  close: () => void;
};

function wsUrl(callId: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/ws/call/${callId}`;
}

const PING_INTERVAL_MS = 30_000;

export function connectCallSocket(callId: string, handlers: CallSocketHandlers): CallSocketHandle {
  const ws = new WebSocket(wsUrl(callId));
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  // A caller's `send()` can run before the handshake finishes — e.g.
  // `acceptIncomingCall()` sends `{t:'accept'}` on the line right after
  // `connectCallSocket()` returns, while `ws.readyState` is still
  // `CONNECTING`. Queue until `open` instead of silently dropping.
  const queue: CallSignalFrame[] = [];

  function send(frame: CallSignalFrame): void {
    const wire = callSignalFrameSchema.parse(frame);
    if (ws.readyState !== WebSocket.OPEN) {
      queue.push(wire);
      return;
    }
    ws.send(JSON.stringify(wire));
  }

  ws.addEventListener('open', () => {
    for (const frame of queue.splice(0)) ws.send(JSON.stringify(frame));
    pingTimer = setInterval(() => send({ t: 'ping' }), PING_INTERVAL_MS);
  });
  ws.addEventListener('message', (event) => {
    const parsed = callServerFrameSchema.safeParse(JSON.parse(String(event.data)));
    if (parsed.success) handlers.onFrame(parsed.data);
  });
  ws.addEventListener('close', () => {
    if (pingTimer) clearInterval(pingTimer);
    handlers.onClose();
  });
  ws.addEventListener('error', () => ws.close());

  return {
    send,
    close: () => {
      if (pingTimer) clearInterval(pingTimer);
      ws.close();
    },
  };
}
