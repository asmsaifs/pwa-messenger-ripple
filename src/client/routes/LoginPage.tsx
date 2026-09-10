import { useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import {
  AuthClientError,
  authErrorMessage,
  isResendableAuthError,
  sendVerificationEmail,
  signInEmail,
} from '../lib/auth-client';
import { useInvalidateMe } from '../lib/queries/me';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const invalidateMe = useInvalidateMe();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname;

  const [searchParams] = useSearchParams();
  const linkErrorCode = searchParams.get('error');
  const linkErrorMessage = authErrorMessage(linkErrorCode);
  const [resendStatus, setResendStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  const handleResend = () => {
    if (!email) return;
    setResendStatus('sending');
    void sendVerificationEmail({ email })
      .then(() => setResendStatus('sent'))
      .catch(() => setResendStatus('error'));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    void signInEmail({ email, password })
      .then(async () => {
        await invalidateMe();
        void navigate(from ?? '/chats', { replace: true });
      })
      .catch((err: unknown) => {
        setError(err instanceof AuthClientError ? err.message : 'Sign in failed.');
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Log in</CardTitle>
      </CardHeader>
      <CardContent>
        {linkErrorMessage && (
          <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
            {linkErrorMessage}
          </p>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            Email
            <Input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            Password
            <Input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error && <p className="text-sm text-red-600">{error}</p>}

          {isResendableAuthError(linkErrorCode) && (
            <div className="flex flex-col gap-1">
              <Button
                type="button"
                variant="outline"
                disabled={!email || resendStatus === 'sending'}
                onClick={handleResend}
              >
                {resendStatus === 'sending' ? 'Sending…' : 'Resend verification email'}
              </Button>
              {resendStatus === 'sent' && (
                <p className="text-sm text-ink-muted">
                  If that email has an account, a new link is on its way.
                </p>
              )}
              {resendStatus === 'error' && (
                <p className="text-sm text-red-600">Couldn't resend — try again.</p>
              )}
            </div>
          )}

          <Button type="submit" disabled={submitting} className="mt-1">
            {submitting ? 'Logging in…' : 'Log in'}
          </Button>

          <div className="flex justify-between text-sm text-ink-muted">
            <Link to="/reset" className="hover:text-brand-600 hover:underline">
              Forgot password?
            </Link>
            <Link to="/signup" className="hover:text-brand-600 hover:underline">
              Sign up
            </Link>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
