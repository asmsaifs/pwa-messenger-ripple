import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useMe } from '../lib/queries/me';

export function RequireAuth() {
  const location = useLocation();
  const me = useMe();

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

  return <Outlet />;
}
