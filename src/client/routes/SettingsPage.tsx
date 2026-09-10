import { useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { signOut } from '../lib/auth-client';
import { useMe, useInvalidateMe } from '../lib/queries/me';
import { NotificationsSection } from '../components/NotificationsSection';
import { ProfileSection } from '../components/settings/ProfileSection';
import { AppearanceSection } from '../components/settings/AppearanceSection';
import { AudioDevicesSection } from '../components/settings/AudioDevicesSection';
import { StorageSection } from '../components/settings/StorageSection';
import { PrivacySection } from '../components/settings/PrivacySection';
import { DevicesSection } from '../components/settings/DevicesSection';
import { DataSection } from '../components/settings/DataSection';
import { AboutSection } from '../components/settings/AboutSection';

// M15 (docs/09): full settings — profile, appearance, notifications, audio
// devices, storage, privacy (blocked list), devices, data (export/delete),
// about.
export function SettingsPage() {
  const me = useMe();
  const invalidateMe = useInvalidateMe();
  const navigate = useNavigate();

  return (
    <div className="mx-auto w-full max-w-md min-h-0 flex-1 overflow-y-auto p-6 dark:text-slate-50">
      <h1 className="text-lg font-semibold">Settings</h1>

      <div className="mt-4 space-y-6">
        {me.data && <ProfileSection />}
        <AppearanceSection />
        <NotificationsSection />
        <AudioDevicesSection />
        <StorageSection />
        <PrivacySection />
        <DevicesSection />
        <DataSection />
        <AboutSection />
      </div>

      <Button
        className="mt-6"
        variant="outline"
        onClick={() => {
          void signOut()
            .catch(() => undefined)
            .then(() => {
              void invalidateMe();
              void navigate('/welcome', { replace: true });
            });
        }}
      >
        Sign out
      </Button>
    </div>
  );
}
