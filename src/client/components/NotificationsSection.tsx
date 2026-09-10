import { Button } from './ui/button';
import { pushPermissionState, pushSupported } from '../lib/push';
import { useDisablePush, useEnablePush, usePushSubscribed, useSendTestPush } from '../lib/queries/push';

// docs/04 §"Notifications": permission state + "Test notification", shown
// after first friend accepted or first incoming-call attempt in the full
// flow (M13/M14) — surfaced unconditionally in Settings for now, same
// pattern as InstallButton's always-visible-when-eligible placement.
export function NotificationsSection() {
  const subscribed = usePushSubscribed();
  const enable = useEnablePush();
  const disable = useDisablePush();
  const test = useSendTestPush();

  if (!pushSupported()) {
    return (
      <section className="border-t border-slate-200 pt-6 dark:border-slate-700">
        <h2 className="text-sm font-semibold">Notifications</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Not supported in this browser.
        </p>
      </section>
    );
  }

  const permission = pushPermissionState();
  const isOn = permission === 'granted' && subscribed.data === true;

  return (
    <section className="border-t border-slate-200 pt-6 dark:border-slate-700">
      <h2 className="text-sm font-semibold">Notifications</h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {permission === 'denied'
          ? 'Blocked in browser settings — re-enable it there to get notified.'
          : isOn
            ? 'Get notified about new messages and friend requests.'
            : 'Get notified when friends message or add you.'}
      </p>
      <div className="mt-3 flex gap-2">
        {isOn ? (
          <Button
            variant="outline"
            size="sm"
            disabled={disable.isPending}
            onClick={() => void disable.mutate()}
          >
            Turn off
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={permission === 'denied' || enable.isPending}
            onClick={() => void enable.mutate()}
          >
            Enable notifications
          </Button>
        )}
        {isOn && (
          <Button
            variant="outline"
            size="sm"
            disabled={test.isPending}
            onClick={() => void test.mutate()}
          >
            Send test notification
          </Button>
        )}
      </div>
      {isOn && (
        <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
          For incoming calls: closing Ripple entirely only gets you a single
          notification chime. Minimize the window instead of closing it to
          hear the full ringtone.
        </p>
      )}
    </section>
  );
}
