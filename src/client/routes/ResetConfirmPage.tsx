import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { AuthClientError, resetPassword } from '../lib/auth-client';

export function ResetConfirmPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) {
      setError('This reset link is missing its token.');
      return;
    }
    setError(null);
    setSubmitting(true);
    void resetPassword({ newPassword: password, token })
      .then(() => navigate('/login', { replace: true }))
      .catch((err: unknown) => {
        setError(err instanceof AuthClientError ? err.message : 'Could not reset password.');
      })
      .finally(() => setSubmitting(false));
  };

  if (!token) {
    return <p className="text-center text-sm text-red-600">This reset link is invalid or expired.</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Choose a new password</h1>

      <label className="flex flex-col gap-1 text-sm">
        New password
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

      {error && <p className="text-sm text-red-600">{error}</p>}

      <Button type="submit" disabled={submitting}>
        {submitting ? 'Saving…' : 'Save password'}
      </Button>
    </form>
  );
}
