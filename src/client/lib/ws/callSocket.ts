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

  function send(frame: CallSignalFrame): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(callSignalFrameSchema.parse(frame)));
  }

  ws.addEventListener('open', () => {
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
