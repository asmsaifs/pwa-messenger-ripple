import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  User,
  Palette,
  Bell,
  Mic,
  HardDrive,
  ShieldCheck,
  Laptop,
  Database,
  Info,
  LogOut,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '../components/ui/button';
import { signOut } from '../lib/auth-client';
import { useInvalidateMe } from '../lib/queries/me';
import { NotificationsSection } from '../components/NotificationsSection';
import { ProfileSection } from '../components/settings/ProfileSection';
import { AppearanceSection } from '../components/settings/AppearanceSection';
import { AudioDevicesSection } from '../components/settings/AudioDevicesSection';
import { StorageSection } from '../components/settings/StorageSection';
import { PrivacySection } from '../components/settings/PrivacySection';
import { DevicesSection } from '../components/settings/DevicesSection';
import { DataSection } from '../components/settings/DataSection';
import { AboutSection } from '../components/settings/AboutSection';

const SECTIONS = [
  { id: 'profile', label: 'Profile', icon: User, Component: ProfileSection },
  { id: 'appearance', label: 'Appearance', icon: Palette, Component: AppearanceSection },
  { id: 'notifications', label: 'Notifications', icon: Bell, Component: NotificationsSection },
  { id: 'audio', label: 'Audio devices', icon: Mic, Component: AudioDevicesSection },
  { id: 'storage', label: 'Storage', icon: HardDrive, Component: StorageSection },
  { id: 'privacy', label: 'Privacy', icon: ShieldCheck, Component: PrivacySection },
  { id: 'devices', label: 'Devices', icon: Laptop, Component: DevicesSection },
  { id: 'data', label: 'Data', icon: Database, Component: DataSection },
  { id: 'about', label: 'About', icon: Info, Component: AboutSection },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

// M15 (docs/09): full settings — profile, appearance, notifications, audio
// devices, storage, privacy (blocked list), devices, data (export/delete),
// about. Laid out as a left menu / right detail pane (≥lg), collapsing to a
// list-then-detail drill-down on narrower screens — same "stacked on mobile"
// idea ChatShellLayout uses for the chat list/thread split, done here with
// local state instead of a route since docs/04 §1's route map keeps
// `/settings` a single route.
export function SettingsPage() {
  const invalidateMe = useInvalidateMe();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<SectionId | null>(null);

  const activeId = selected ?? 'profile';
  // `activeId` is always either the default 'profile' or a value set from
  // `SECTIONS` itself two lines below, so a match always exists.
  const Active = SECTIONS.find((s) => s.id === activeId)!.Component;

  function handleSignOut() {
    void signOut()
      .catch(() => undefined)
      .then(() => {
        void invalidateMe();
        void navigate('/welcome', { replace: true });
      });
  }

  return (
    <div className="flex h-full flex-1 flex-col lg:flex-row">
      <nav
        aria-label="Settings sections"
        className={cn(
          'w-full shrink-0 overflow-y-auto border-border-subtle lg:block lg:w-64 lg:border-r',
          selected !== null && 'hidden lg:block',
        )}
      >
        <div className="p-4 lg:p-6">
          <h1 className="font-display text-lg font-semibold text-ink">Settings</h1>
        </div>
        <ul className="px-2 pb-2 lg:px-3">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setSelected(s.id)}
                aria-current={activeId === s.id ? 'page' : undefined}
                className={cn(
                  'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors',
                  activeId === s.id
                    ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300'
                    : 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
                )}
              >
                <s.icon className="size-5 shrink-0" aria-hidden="true" />
                <span className="flex-1">{s.label}</span>
                <ChevronRight className="size-4 shrink-0 text-ink-muted lg:hidden" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t border-border-subtle p-3">
          <Button variant="outline" className="w-full justify-start gap-2" onClick={handleSignOut}>
            <LogOut className="size-4" aria-hidden="true" />
            Sign out
          </Button>
        </div>
      </nav>

      <div className={cn('min-h-0 flex-1 overflow-y-auto', selected === null && 'hidden lg:block')}>
        <div className="mx-auto w-full max-w-xl p-4 sm:p-6">
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="mb-4 text-sm text-ink-muted hover:text-ink lg:hidden"
          >
            ← Settings
          </button>
          <Active />
        </div>
      </div>
    </div>
  );
}
