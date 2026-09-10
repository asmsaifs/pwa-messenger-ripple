import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useMe } from '../lib/queries/me';
import { useUserSocket, type UserConnectionStatus } from '../lib/ws/userSocket';
import { initRingtone } from '../lib/webrtc/ringtone';

export type RequireAuthContext = { showReconnecting: boolean; userSocketStatus: UserConnectionStatus };

// UserDO's personal socket (docs/01 §6: "at most 2 sockets — UserDO always +
// ConversationDO ... plus a third, short-lived, to CallDO during a call")
// mounts here rather than in AppLayout — `/call/:callId` (docs/04 §1) is a
// sibling route outside AppLayout, and the personal socket must stay open
// through a call (that's how `incoming_call`/`call_cancelled` keep working
// and how a second device's badge stays in sync) instead of unmounting the
// moment the user navigates to it.
export function RequireAuth() {
  const location = useLocation();
  const me = useMe();
  const { status, showReconnecting } = useUserSocket(Boolean(me.data));

  // docs/04 incoming-call ringtone (M14) — one subscription for the whole
  // authenticated session, same lifetime rationale as the socket above.
  useEffect(() => initRingtone(), []);

  if (me.isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-sm text-slate-500">
        Loading…
      </div>
    );
  }

  if (me.isError) {
    return <Navigate to="/welcome" replace state={{ from: location }} />;
  }

  return <Outlet context={{ showReconnecting, userSocketStatus: status } satisfies RequireAuthContext} />;
}
