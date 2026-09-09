import { useState } from 'react';
import { Button } from '../components/ui/button';
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
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 sm:flex-row sm:items-start">
      <div className="flex flex-1 flex-col gap-1">
        <label htmlFor="invite-email" className="sr-only">
          Email
        </label>
        <input
          id="invite-email"
          type="email"
          required
          placeholder="friend@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        {message && <p className="text-sm text-slate-500">{message}</p>}
      </div>
      <Button type="submit" disabled={invite.isPending}>
        {invite.isPending ? 'Sending…' : 'Invite'}
      </Button>
    </form>
  );
}

function FriendRow({ friend }: { friend: FriendSummary }) {
  const block = useBlockFriendship();
  const remove = useRemoveFriendship();
  return (
    <li className="flex items-center justify-between border-b border-slate-100 py-3">
      <div>
        <p className="text-sm font-medium">{friend.displayName}</p>
        {friend.statusText && <p className="text-xs text-slate-500">{friend.statusText}</p>}
      </div>
      <div className="flex gap-2">
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
    <li className="flex items-center justify-between border-b border-slate-100 py-3">
      <p className="text-sm font-medium">{request.displayName}</p>
      {direction === 'incoming' ? (
        <div className="flex gap-2">
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
    <li className="flex items-center justify-between border-b border-slate-100 py-3">
      <div>
        <p className="text-sm font-medium">{invitation.email}</p>
        <p className="text-xs text-slate-500">
          Expires {new Date(invitation.expiresAt).toLocaleDateString()}
        </p>
      </div>
      <div className="flex gap-2">
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
    <div className="flex flex-col gap-6 p-6">
      <h1 className="text-lg font-semibold">Friends</h1>
      <InviteForm />

      <nav className="flex gap-4 border-b border-slate-200 text-sm">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-1 py-2 capitalize ${
              tab === t ? 'border-slate-900 font-medium text-slate-900' : 'border-transparent text-slate-500'
            }`}
          >
            {t}
            {t === 'requests' && friends.data && friends.data.incoming.length > 0
              ? ` (${friends.data.incoming.length})`
              : ''}
          </button>
        ))}
      </nav>

      {friends.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {friends.isError && <p className="text-sm text-red-600">Couldn't load friends. Try again.</p>}

      {friends.data && tab === 'friends' && (
        <ul>
          {friends.data.friends.length === 0 && (
            <p className="text-sm text-slate-500">No friends yet — invite someone above.</p>
          )}
          {friends.data.friends.map((f) => (
            <FriendRow key={f.friendshipId} friend={f} />
          ))}
        </ul>
      )}

      {friends.data && tab === 'requests' && (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="mb-1 text-sm font-medium text-slate-500">Incoming</h2>
            <ul>
              {friends.data.incoming.length === 0 && (
                <p className="text-sm text-slate-500">No incoming requests.</p>
              )}
              {friends.data.incoming.map((r) => (
                <RequestRow key={r.friendshipId} request={r} direction="incoming" />
              ))}
            </ul>
          </div>
          <div>
            <h2 className="mb-1 text-sm font-medium text-slate-500">Outgoing</h2>
            <ul>
              {friends.data.outgoing.length === 0 && (
                <p className="text-sm text-slate-500">No outgoing requests.</p>
              )}
              {friends.data.outgoing.map((r) => (
                <RequestRow key={r.friendshipId} request={r} direction="outgoing" />
              ))}
            </ul>
          </div>
        </div>
      )}

      {friends.data && tab === 'invited' && (
        <ul>
          {friends.data.invitations.length === 0 && (
            <p className="text-sm text-slate-500">No pending invitations.</p>
          )}
          {friends.data.invitations.map((inv) => (
            <InvitationRow key={inv.id} invitation={inv} />
          ))}
        </ul>
      )}
    </div>
  );
}
