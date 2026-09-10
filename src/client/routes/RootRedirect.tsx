import { Navigate, useLocation } from 'react-router-dom';
import { useMe } from '../lib/queries/me';

// docs/04 §1: `/` → redirect: authed ? /chats : /welcome.
export function RootRedirect() {
  const me = useMe();
  const location = useLocation();

  if (me.isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-sm text-slate-500">
        Loading…
      </div>
    );
  }

  // Better Auth's verify-email/reset-password redirects land here with an
  // `?error=` code (e.g. TOKEN_EXPIRED) — preserve it so the destination
  // page can surface it instead of silently dropping it.
  return (
    <Navigate
      to={{ pathname: me.isError ? '/welcome' : '/chats', search: location.search }}
      replace
    />
  );
}
