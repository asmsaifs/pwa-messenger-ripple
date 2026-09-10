import { NavLink, Outlet } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { OfflineBanner } from '../components/OfflineBanner';
import { InstallButton } from '../components/InstallButton';
import { useMe } from '../lib/queries/me';
import { usePushNotificationNav } from '../lib/usePushNotificationNav';
import { useUserSocket } from '../lib/ws/userSocket';

const NAV_LINKS = [
  { to: '/chats', label: 'Chats' },
  { to: '/friends', label: 'Friends' },
  { to: '/settings', label: 'Settings' },
];

// The authenticated app shell: header + nav, wrapping every route behind
// RequireAuth. Chats/thread get their own two-pane layout nested below this
// (ChatShellLayout) — this level only owns the chrome shared by every screen.
export function AppLayout() {
  const me = useMe();
  // UserDO's personal socket (docs/09 M7) — mounted once for the whole
  // authenticated session, not per-thread like useConversationSocket.
  const { showReconnecting } = useUserSocket(Boolean(me.data));
  usePushNotificationNav();
  const unreadTotal = me.data?.unreadTotal ?? 0;

  return (
    <div className="flex min-h-dvh flex-col bg-white">
      <OfflineBanner />
      {showReconnecting && (
        <div role="status" className="w-full bg-slate-100 px-4 py-1 text-center text-xs text-slate-600">
          Reconnecting…
        </div>
      )}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 px-4">
        <div className="flex items-center gap-6">
          <span className="text-sm font-semibold">Ripple</span>
          <nav className="flex gap-4 text-sm">
            {NAV_LINKS.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                className={({ isActive }) =>
                  cn('relative text-slate-500 hover:text-slate-900', isActive && 'font-medium text-slate-900')
                }
              >
                {link.label}
                {link.to === '/chats' && unreadTotal > 0 && (
                  <span
                    data-testid="nav-unread-badge"
                    className="ml-1 inline-flex size-4 items-center justify-center rounded-full bg-blue-600 text-[10px] font-medium text-white"
                  >
                    {unreadTotal > 9 ? '9+' : unreadTotal}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <InstallButton variant="ghost" />
          {me.data && <span className="text-sm text-slate-500">{me.data.profile.displayName}</span>}
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}
