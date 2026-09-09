import { Outlet } from 'react-router-dom';

// Layout for /welcome, /signup, /login, /reset*, /invite/:token — the routes
// that must render for a signed-out (or offline) visitor.
export function PublicLayout() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-sm">
        <Outlet />
      </div>
    </div>
  );
}
