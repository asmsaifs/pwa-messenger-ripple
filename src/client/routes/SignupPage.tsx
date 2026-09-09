import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Turnstile } from '../components/Turnstile';
import { AuthClientError, signUpEmail } from '../lib/auth-client';

const TURNSTILE_SITE_KEY: string | undefined = import.meta.env.VITE_TURNSTILE_SITE_KEY;

export function SignupPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [searchParams] = useSearchParams();
  const invite = searchParams.get('invite');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    void signUpEmail({
      name,
      email,
      password,
      ...(captchaToken ? { captchaResponse: captchaToken } : {}),
    })
      .then(() => setSubmitted(true))
      .catch((err: unknown) => {
        setError(err instanceof AuthClientError ? err.message : 'Sign up failed.');
      })
      .finally(() => setSubmitting(false));
  };

  if (submitted) {
    return (
      <div className="text-center">
        <h1 className="text-xl font-semibold">Check your email</h1>
        <p className="mt-2 text-sm text-slate-500">
          We sent a verification link to {email}. Verify it, then{' '}
          <Link to="/login" className="text-blue-600 hover:underline">
            log in
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Sign up</h1>
      {invite && <p className="text-sm text-slate-500">Joining via invite.</p>}

      <label className="flex flex-col gap-1 text-sm">
        Name
        <input
          required
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Email
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Password
        <input
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </label>

      {TURNSTILE_SITE_KEY && <Turnstile siteKey={TURNSTILE_SITE_KEY} onToken={setCaptchaToken} />}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <Button type="submit" disabled={submitting || (Boolean(TURNSTILE_SITE_KEY) && !captchaToken)}>
        {submitting ? 'Signing up…' : 'Sign up'}
      </Button>

      <p className="text-center text-sm text-slate-500">
        Already have an account?{' '}
        <Link to="/login" className="hover:underline">
          Log in
        </Link>
      </p>
    </form>
  );
}
