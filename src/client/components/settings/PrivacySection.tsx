import { Button } from '../ui/button';
import { useFriends, useUnblockFriendship } from '../../lib/queries/friends';

// docs/04 §"Settings": "Privacy (blocked list)".
export function PrivacySection() {
  const friends = useFriends();
  const unblock = useUnblockFriendship();
  const blocked = friends.data?.blocked ?? [];

  return (
    <section className="border-t border-slate-200 pt-6 dark:border-slate-700">
      <h2 className="text-sm font-semibold">Privacy</h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        People you've blocked can't message, call, or see your profile.
      </p>
      {blocked.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">Nobody's blocked.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {blocked.map((b) => (
            <li key={b.friendshipId} className="flex items-center justify-between gap-3 text-sm">
              <span>{b.displayName}</span>
              <Button
                size="sm"
                variant="outline"
                disabled={unblock.isPending}
                onClick={() => unblock.mutate(b.friendshipId)}
              >
                Unblock
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
