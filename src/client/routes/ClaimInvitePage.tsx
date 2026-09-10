import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useClaimInvitation } from '../lib/queries/friends';
import { LogoMark } from '../components/Logo';

// Landing spot for the signup->verify round trip when signup started from an
// invite link (SignupPage passes `callbackURL=/invite/claim?token=...` to
// Better Auth's sign-up so the post-verification redirect lands here already
// signed in — docs/03 "Auth": "?invite=<token> ... claimed after
// verification"). Claims once, then moves on regardless of outcome: an
// expired/already-claimed token shouldn't block the person from reaching the
// app they just verified into.
export function ClaimInvitePage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const navigate = useNavigate();
  const claim = useClaimInvitation();
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current || !token) {
      void navigate('/chats', { replace: true });
      return;
    }
    attempted.current = true;
    claim.mutate(token, {
      onSettled: () => void navigate('/chats', { replace: true }),
    });
    // `claim`/`navigate` are stable across renders in practice here; this
    // effect is meant to run exactly once per mount, gated by `attempted`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-surface-sunken text-ink-muted">
      <LogoMark className="size-8 animate-pulse" />
      <p className="text-sm">Setting things up…</p>
    </div>
  );
}
