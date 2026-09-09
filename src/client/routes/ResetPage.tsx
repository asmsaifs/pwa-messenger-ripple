import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { AuthClientError, forgetPassword } from '../lib/auth-client';

export function ResetPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    void forgetPassword({ email })
      .then(() => setSent(true))
      .catch((err: unknown) => {
        setError(err instanceof AuthClientError ? err.message : 'Could not send reset email.');
      })
      .finally(() => setSubmitting(false));
  };

  if (sent) {
    return (
      <p className="text-center text-sm text-slate-500">
        If an account exists for {email}, a reset link is on its way.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Reset password</h1>

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

      {error && <p className="text-sm text-red-600">{error}</p>}

      <Button type="submit" disabled={submitting}>
        {submitting ? 'Sending…' : 'Send reset link'}
      </Button>

      <Link to="/login" className="text-center text-sm text-slate-500 hover:underline">
        Back to log in
      </Link>
    </form>
  );
}
