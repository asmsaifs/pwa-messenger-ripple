import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, buttonVariants } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Avatar } from '../components/ui/avatar';
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
    return <p className="text-center text-sm text-ink-muted">Loading…</p>;
  }

  if (preview.isError) {
    const expired =
      preview.error instanceof ApiError && preview.error.code === 'policy/not-found';
    return (
      <Card>
        <CardContent className="pt-5 text-center sm:pt-5">
          <h1 className="font-display text-xl font-semibold text-ink">Invite not found</h1>
          <p className="mt-2 text-sm text-ink-muted">
            {expired
              ? "This invite link has expired or was already used."
              : 'Something went wrong loading this invite.'}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 pt-5 text-center sm:pt-5">
        <Avatar name={preview.data?.inviterName ?? '?'} size="lg" />
        <h1 className="font-display text-xl font-semibold text-ink">
          {preview.data?.inviterName} invited you to Ripple
        </h1>

        {me.data ? (
          <>
            <Button
              className="mt-1 w-full"
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
              <p className="text-sm text-red-600">
                {claim.error instanceof ApiError
                  ? messageForErrorCode(claim.error.code)
                  : 'Something went wrong.'}
              </p>
            )}
          </>
        ) : (
          <Link
            to={`/signup?invite=${encodeURIComponent(token ?? '')}`}
            className={buttonVariants({ className: 'mt-1 w-full' })}
          >
            Sign up to connect
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
