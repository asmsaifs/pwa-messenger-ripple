import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, buttonVariants } from '../components/ui/button';
import { ApiError } from '../lib/api';
import { messageForErrorCode } from '../lib/errors/messages';
import { useMe } from '../lib/queries/me';
import { useClaimInvitation, useInvitePreview } from '../lib/queries/friends';

// Works logged out (docs/04 §1): shows who invited the visitor, then routes
// them to sign up (?invite= carries the token through verification) or, if
// they're already signed in, lets them claim directly.
export function InvitePreviewPage() {
  const { token } = useParams<{ token: string }>();
  const preview = useInvitePreview(token);
  const me = useMe();
  const claim = useClaimInvitation();
  const navigate = useNavigate();

  if (preview.isLoading || me.isLoading) {
    return <p className="text-center text-sm text-slate-500">Loading…</p>;
  }

  if (preview.isError) {
    const expired =
      preview.error instanceof ApiError && preview.error.code === 'policy/not-found';
    return (
      <div className="text-center">
        <h1 className="text-xl font-semibold">Invite not found</h1>
        <p className="mt-2 text-sm text-slate-500">
          {expired
            ? "This invite link has expired or was already used."
            : 'Something went wrong loading this invite.'}
        </p>
      </div>
    );
  }

  return (
    <div className="text-center">
      <h1 className="text-xl font-semibold">
        {preview.data?.inviterName} invited you to Ripple
      </h1>

      {me.data ? (
        <>
          <Button
            className="mt-4"
            disabled={claim.isPending}
            onClick={() =>
              claim.mutate(token ?? '', {
                onSuccess: () => void navigate('/chats'),
              })
            }
          >
            {claim.isPending ? 'Adding friend…' : 'Add as friend'}
          </Button>
          {claim.isError && (
            <p className="mt-2 text-sm text-red-600">
              {claim.error instanceof ApiError
                ? messageForErrorCode(claim.error.code)
                : 'Something went wrong.'}
            </p>
          )}
        </>
      ) : (
        <Link
          to={`/signup?invite=${encodeURIComponent(token ?? '')}`}
          className={buttonVariants({ className: 'mt-4' })}
        >
          Sign up to connect
        </Link>
      )}
    </div>
  );
}
