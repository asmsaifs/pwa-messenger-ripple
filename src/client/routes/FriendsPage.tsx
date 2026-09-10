import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Avatar } from '../components/ui/avatar';
import { Badge } from '../components/ui/badge';
import { messageForErrorCode } from '../lib/errors/messages';
import { ApiError } from '../lib/api';
import {
  useAcceptFriendship,
  useBlockFriendship,
  useDeclineFriendship,
  useFriends,
  useInviteByEmail,
  useRemoveFriendship,
  useResendInvitation,
  useRevokeInvitation,
} from '../lib/queries/friends';
import { cn } from '@/lib/utils';
import type { FriendRequestSummary, FriendSummary, InvitationSummary } from '@shared/friends';

const TABS = ['friends', 'requests', 'invited'] as const;
type Tab = (typeof TABS)[number];

function InviteForm() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const invite = useInviteByEmail();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    invite.mutate(
      { email },
      {
        onSuccess: (res) => {
          setMessage(
            res.kind === 'request_sent'
              ? `Friend request sent to ${email}.`
              : `Invitation sent to ${email}.`,
          );
          setEmail('');
        },
        onError: (err) => {
          setMessage(err instanceof ApiError ? messageForErrorCode(err.code) : 'Something went wrong.');
        },
      },
    );
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-card border border-border-subtle bg-surface p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="flex flex-1 flex-col gap-1">
          <label htmlFor="invite-email" className="sr-only">
            Email
          </label>
          <Input
            id="invite-email"
            type="email"
            required
            placeholder="friend@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {message && <p className="text-sm text-ink-muted">{message}</p>}
        </div>
        <Button type="submit" disabled={invite.isPending}>
          {invite.isPending ? 'Sending…' : 'Invite'}
        </Button>
      </div>
    </form>
  );
}

function FriendRow({ friend }: { friend: FriendSummary }) {
  const block = useBlockFriendship();
  const remove = useRemoveFriendship();
  return (
    <li className="flex items-center justify-between gap-3 border-b border-border-subtle py-3 last:border-0">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={friend.displayName} avatarKey={friend.avatarKey} size="sm" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{friend.displayName}</p>
          {friend.statusText && <p className="truncate text-xs text-ink-muted">{friend.statusText}</p>}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="outline" size="sm" onClick={() => remove.mutate(friend.friendshipId)}>
          Remove
        </Button>
        <Button variant="outline" size="sm" onClick={() => block.mutate(friend.friendshipId)}>
          Block
        </Button>
      </div>
    </li>
  );
}

function RequestRow({ request, direction }: { request: FriendRequestSummary; direction: 'incoming' | 'outgoing' }) {
  const accept = useAcceptFriendship();
  const decline = useDeclineFriendship();
  return (
    <li className="flex items-center justify-between gap-3 border-b border-border-subtle py-3 last:border-0">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={request.displayName} avatarKey={request.avatarKey} size="sm" />
        <p className="truncate text-sm font-medium text-ink">{request.displayName}</p>
      </div>
      {direction === 'incoming' ? (
        <div className="flex shrink-0 gap-2">
          <Button size="sm" onClick={() => accept.mutate(request.friendshipId)}>
            Accept
          </Button>
          <Button variant="outline" size="sm" onClick={() => decline.mutate(request.friendshipId)}>
            Decline
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => decline.mutate(request.friendshipId)}>
          Cancel
        </Button>
      )}
    </li>
  );
}

function InvitationRow({ invitation }: { invitation: InvitationSummary }) {
  const resend = useResendInvitation();
  const revoke = useRevokeInvitation();
  return (
    <li className="flex flex-col gap-1 border-b border-border-subtle py-3 last:border-0">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{invitation.email}</p>
          <p className="text-xs text-ink-muted">
            Expires {new Date(invitation.expiresAt).toLocaleDateString()}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={resend.isPending}
            onClick={() => resend.mutate(invitation.id)}
          >
            Resend
          </Button>
          <Button variant="outline" size="sm" onClick={() => revoke.mutate(invitation.id)}>
            Revoke
          </Button>
        </div>
      </div>
      {resend.isError && (
        <p className="text-xs text-red-600">
          {resend.error instanceof ApiError ? messageForErrorCode(resend.error.code) : 'Failed to resend.'}
        </p>
      )}
    </li>
  );
}

export function FriendsPage() {
  const [tab, setTab] = useState<Tab>('friends');
  const friends = useFriends();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
      <h1 className="font-display text-lg font-semibold text-ink">Friends</h1>
      <InviteForm />

      <nav className="flex gap-4 border-b border-border-subtle text-sm">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 px-1 py-2 capitalize transition-colors',
              tab === t ? 'border-brand-500 font-medium text-brand-700 dark:text-brand-300' : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {t}
            {t === 'requests' && friends.data && friends.data.incoming.length > 0 && (
              <Badge>{friends.data.incoming.length}</Badge>
            )}
          </button>
        ))}
      </nav>

      {friends.isLoading && <p className="text-sm text-ink-muted">Loading…</p>}
      {friends.isError && <p className="text-sm text-red-600">Couldn't load friends. Try again.</p>}

      {friends.data && tab === 'friends' && (
        <ul className="rounded-card border border-border-subtle bg-surface px-4">
          {friends.data.friends.length === 0 && (
            <p className="py-4 text-sm text-ink-muted">No friends yet — invite someone above.</p>
          )}
          {friends.data.friends.map((f) => (
            <FriendRow key={f.friendshipId} friend={f} />
          ))}
        </ul>
      )}

      {friends.data && tab === 'requests' && (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="mb-1 text-sm font-medium text-ink-muted">Incoming</h2>
            <ul className="rounded-card border border-border-subtle bg-surface px-4">
              {friends.data.incoming.length === 0 && (
                <p className="py-4 text-sm text-ink-muted">No incoming requests.</p>
              )}
              {friends.data.incoming.map((r) => (
                <RequestRow key={r.friendshipId} request={r} direction="incoming" />
              ))}
            </ul>
          </div>
          <div>
            <h2 className="mb-1 text-sm font-medium text-ink-muted">Outgoing</h2>
            <ul className="rounded-card border border-border-subtle bg-surface px-4">
              {friends.data.outgoing.length === 0 && (
                <p className="py-4 text-sm text-ink-muted">No outgoing requests.</p>
              )}
              {friends.data.outgoing.map((r) => (
                <RequestRow key={r.friendshipId} request={r} direction="outgoing" />
              ))}
            </ul>
          </div>
        </div>
      )}

      {friends.data && tab === 'invited' && (
        <ul className="rounded-card border border-border-subtle bg-surface px-4">
          {friends.data.invitations.length === 0 && (
            <p className="py-4 text-sm text-ink-muted">No pending invitations.</p>
          )}
          {friends.data.invitations.map((inv) => (
            <InvitationRow key={inv.id} invitation={inv} />
          ))}
        </ul>
      )}
    </div>
  );
}
