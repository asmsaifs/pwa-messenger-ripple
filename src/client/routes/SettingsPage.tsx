import { useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { signOut } from '../lib/auth-client';
import { useMe, useInvalidateMe } from '../lib/queries/me';
import { NotificationsSection } from '../components/NotificationsSection';

// Full settings (devices, storage, privacy, data export/delete) land in M15
// (docs/09) — this is the profile summary + sign-out that's useful now, plus
// M12's notification permission toggle.
export function SettingsPage() {
  const me = useMe();
  const invalidateMe = useInvalidateMe();
  const navigate = useNavigate();

  return (
    <div className="mx-auto w-full max-w-md p-6">
      <h1 className="text-lg font-semibold">Settings</h1>

      {me.data && (
        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-slate-500">Name</dt>
            <dd>{me.data.profile.displayName}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-500">Email</dt>
            <dd>{me.data.user.email}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-500">Email verified</dt>
            <dd>{me.data.user.emailVerified ? 'Yes' : 'No'}</dd>
          </div>
        </dl>
      )}

      <NotificationsSection />

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
