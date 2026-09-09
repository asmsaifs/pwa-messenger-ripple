import { Navigate } from 'react-router-dom';
import { useMe } from '../lib/queries/me';

// docs/04 §1: `/` → redirect: authed ? /chats : /welcome.
export function RootRedirect() {
  const me = useMe();

  if (me.isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-sm text-slate-500">
        Loading…
      </div>
    );
  }

  return <Navigate to={me.isError ? '/welcome' : '/chats'} replace />;
}
