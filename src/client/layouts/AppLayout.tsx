import { NavLink, Outlet, useOutletContext } from 'react-router-dom';
import { MessageCircle, Users, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { OfflineBanner } from '../components/OfflineBanner';
import { InstallButton } from '../components/InstallButton';
import { CallMinimizedBar } from '../components/CallMinimizedBar';
import { Logo, LogoMark } from '../components/Logo';
import { Avatar } from '../components/ui/avatar';
import { Badge } from '../components/ui/badge';
import { useMe } from '../lib/queries/me';
import { usePushNotificationNav } from '../lib/usePushNotificationNav';
import type { RequireAuthContext } from './RequireAuth';

const NAV_LINKS = [
  { to: '/chats', label: 'Chats', icon: MessageCircle },
  { to: '/friends', label: 'Friends', icon: Users },
  { to: '/settings', label: 'Settings', icon: Settings },
];

// The authenticated app shell: a left rail on desktop/tablet, a bottom tab
// bar on mobile (docs/04 §1), wrapping every route behind RequireAuth.
// Chats/thread get their own two-pane layout nested below this
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
    <div className="flex h-dvh flex-col overflow-hidden bg-surface-sunken text-ink lg:flex-row">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>

      {/* Desktop / tablet left rail */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-border-subtle bg-surface px-3 py-4 lg:flex">
        <div className="px-2 pb-6">
          <Logo />
        </div>
        <nav aria-label="Primary" className="flex flex-1 flex-col gap-1">
          {NAV_LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink',
                  isActive && 'bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300',
                )
              }
            >
              <link.icon className="size-5" aria-hidden="true" />
              <span className="flex-1">{link.label}</span>
              {link.to === '/chats' && unreadTotal > 0 && (
                <Badge data-testid="nav-unread-badge">{unreadTotal > 9 ? '9+' : unreadTotal}</Badge>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
          <InstallButton variant="ghost" className="justify-start" />
          {me.data && (
            <div className="flex items-center gap-2.5 px-1 py-1">
              <Avatar name={me.data.profile.displayName} size="sm" />
              <span className="truncate text-sm text-ink-muted">{me.data.profile.displayName}</span>
            </div>
          )}
        </div>
      </aside>

      <div className="flex min-h-0 flex-1 flex-col">
        <OfflineBanner />
        {showReconnecting && (
          <div
            role="status"
            className="w-full bg-surface-sunken px-4 py-1 text-center text-xs text-ink-muted"
          >
            Reconnecting…
          </div>
        )}

        {/* Mobile top bar */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border-subtle bg-surface px-4 lg:hidden">
          <LogoMark className="size-6" />
          <div className="flex items-center gap-2">
            <InstallButton variant="ghost" size="sm" />
            {me.data && <Avatar name={me.data.profile.displayName} size="sm" />}
          </div>
        </header>

        <CallMinimizedBar />

        <main id="main-content" className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-16 lg:pb-0">
          <Outlet />
        </main>

        {/* Mobile bottom tab bar */}
        <nav
          aria-label="Primary"
          className="fixed inset-x-0 bottom-0 z-10 flex h-16 items-stretch border-t border-border-subtle bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
        >
          {NAV_LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) =>
                cn(
                  'relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-ink-muted',
                  isActive && 'text-brand-600 dark:text-brand-400',
                )
              }
            >
              <span className="relative">
                <link.icon className="size-5" aria-hidden="true" />
                {link.to === '/chats' && unreadTotal > 0 && (
                  <Badge
                    data-testid="nav-unread-badge"
                    className="absolute -right-2 -top-1.5 size-4 min-w-4 px-0.5 text-[9px]"
                  >
                    {unreadTotal > 9 ? '9+' : unreadTotal}
                  </Badge>
                )}
              </span>
              {link.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
