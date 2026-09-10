import { NavLink, Outlet, useOutletContext } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { OfflineBanner } from '../components/OfflineBanner';
import { InstallButton } from '../components/InstallButton';
import { CallMinimizedBar } from '../components/CallMinimizedBar';
import { useMe } from '../lib/queries/me';
import { usePushNotificationNav } from '../lib/usePushNotificationNav';
import type { RequireAuthContext } from './RequireAuth';

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
  // UserDO's personal socket (docs/09 M7) is mounted one level up, in
  // RequireAuth, so it stays alive across `/call/:callId` too (docs/01 §6) —
  // this just reads the reconnecting banner state back out.
  const { showReconnecting } = useOutletContext<RequireAuthContext>();
  usePushNotificationNav();
  const unreadTotal = me.data?.unreadTotal ?? 0;

  return (
    <div className="flex min-h-dvh flex-col bg-white dark:bg-slate-950 dark:text-slate-50">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <OfflineBanner />
      {showReconnecting && (
        <div
          role="status"
          className="w-full bg-slate-100 px-4 py-1 text-center text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300"
        >
          Reconnecting…
        </div>
      )}
      <header
        className="titlebar-drag flex h-14 shrink-0 items-center justify-between border-b border-slate-200 px-4 dark:border-slate-700"
        style={{
          height: 'env(titlebar-area-height, 3.5rem)',
          paddingInlineStart: 'env(titlebar-area-x, 1rem)',
          paddingInlineEnd: 'calc(100% - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100%))',
        }}
      >
        <div className="titlebar-no-drag flex items-center gap-6">
          <span className="text-sm font-semibold">Ripple</span>
          <nav aria-label="Primary" className="flex gap-4 text-sm">
            {NAV_LINKS.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                className={({ isActive }) =>
                  cn(
                    'relative text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-50',
                    isActive && 'font-medium text-slate-900 dark:text-slate-50',
                  )
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
        <div className="titlebar-no-drag flex items-center gap-3">
          <InstallButton variant="ghost" />
          {me.data && <span className="text-sm text-slate-500 dark:text-slate-400">{me.data.profile.displayName}</span>}
        </div>
      </header>
      <CallMinimizedBar />
      <main id="main-content" className="flex min-h-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}
