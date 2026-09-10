import { Outlet } from 'react-router-dom';
import { Logo } from '../components/Logo';

// Layout for /welcome, /signup, /login, /reset*, /invite/:token — the routes
// that must render for a signed-out (or offline) visitor.
export function PublicLayout() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-surface-sunken p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo iconClassName="size-8" className="gap-2.5 [&_span]:text-xl" />
        </div>
        <Outlet />
      </div>
    </div>
  );
}
