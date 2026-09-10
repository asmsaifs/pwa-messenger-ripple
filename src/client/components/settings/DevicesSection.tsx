import { Button } from '../ui/button';
import { useRevokeSession, useSessions } from '../../lib/queries/account';

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// docs/04 §"Settings" Devices — Better Auth's `session` rows are this app's
// device list (src/server/routes/me.ts's `GET /api/me/sessions` comment).
export function DevicesSection() {
  const sessions = useSessions();
  const revoke = useRevokeSession();

  return (
    <section className="border-t border-slate-200 pt-6 dark:border-slate-700">
      <h2 className="text-sm font-semibold">Devices</h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Everywhere you're currently signed in.
      </p>
      {sessions.isLoading && <p className="mt-3 text-sm text-slate-500">Loading…</p>}
      {sessions.isError && <p className="mt-3 text-sm text-red-600 dark:text-red-400">Couldn't load devices.</p>}
      <ul className="mt-3 space-y-3">
        {sessions.data?.sessions.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-3 text-sm">
            <div className="min-w-0">
              <p className="truncate">
                {s.userAgent ?? 'Unknown device'}
                {s.current && <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">(this device)</span>}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">Signed in {formatDate(s.createdAt)}</p>
            </div>
            {!s.current && (
              <Button
                size="sm"
                variant="outline"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(s.id)}
              >
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
