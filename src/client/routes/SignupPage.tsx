import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Turnstile } from '../components/Turnstile';
import { AuthClientError, signUpEmail } from '../lib/auth-client';

const TURNSTILE_SITE_KEY: string | undefined = import.meta.env.VITE_TURNSTILE_SITE_KEY;

export function SignupPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [searchParams] = useSearchParams();
  const invite = searchParams.get('invite');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    void signUpEmail({
      name,
      email,
      password,
      ...(captchaToken ? { captchaResponse: captchaToken } : {}),
      ...(invite ? { callbackURL: `/invite/claim?token=${encodeURIComponent(invite)}` } : {}),
    })
      .then(() => setSubmitted(true))
      .catch((err: unknown) => {
        setError(err instanceof AuthClientError ? err.message : 'Sign up failed.');
      })
      .finally(() => setSubmitting(false));
  };

  if (submitted) {
    return (
      <Card>
        <CardContent className="pt-5 text-center sm:pt-5">
          <h1 className="font-display text-xl font-semibold text-ink">Check your email</h1>
          <p className="mt-2 text-sm text-ink-muted">
            We sent a verification link to {email}. Verify it, then{' '}
            <Link to="/login" className="text-brand-600 hover:underline dark:text-brand-400">
              log in
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Sign up</CardTitle>
        {invite && <p className="text-sm text-ink-muted">Joining via invite.</p>}
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            Name
            <Input required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </label>

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
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                required
                minLength={10}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-ink-muted hover:text-ink"
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </label>

          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            Retype password
            <Input
              type={showPassword ? 'text' : 'password'}
              required
              minLength={10}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </label>

          {TURNSTILE_SITE_KEY && <Turnstile siteKey={TURNSTILE_SITE_KEY} onToken={setCaptchaToken} />}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <Button type="submit" disabled={submitting || (Boolean(TURNSTILE_SITE_KEY) && !captchaToken)} className="mt-1">
            {submitting ? 'Signing up…' : 'Sign up'}
          </Button>

          <p className="text-center text-sm text-ink-muted">
            Already have an account?{' '}
            <Link to="/login" className="text-brand-600 hover:underline dark:text-brand-400">
              Log in
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
