import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { AuthClientError, signInEmail } from '../lib/auth-client';
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
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Log in</h1>

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
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </label>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <Button type="submit" disabled={submitting}>
        {submitting ? 'Logging in…' : 'Log in'}
      </Button>

      <div className="flex justify-between text-sm text-slate-500">
        <Link to="/reset" className="hover:underline">
          Forgot password?
        </Link>
        <Link to="/signup" className="hover:underline">
          Sign up
        </Link>
      </div>
    </form>
  );
}
