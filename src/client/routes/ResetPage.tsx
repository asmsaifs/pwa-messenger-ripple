import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
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
      <Card>
        <CardContent className="pt-5 text-center sm:pt-5">
          <p className="text-sm text-ink-muted">
            If an account exists for {email}, a reset link is on its way.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Reset password</CardTitle>
      </CardHeader>
      <CardContent>
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

          {error && <p className="text-sm text-red-600">{error}</p>}

          <Button type="submit" disabled={submitting} className="mt-1">
            {submitting ? 'Sending…' : 'Send reset link'}
          </Button>

          <Link to="/login" className="text-center text-sm text-ink-muted hover:text-brand-600 hover:underline">
            Back to log in
          </Link>
        </form>
      </CardContent>
    </Card>
  );
}
