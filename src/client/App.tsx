import { useEffect, useState } from 'react';
import { healthResponseSchema, type HealthResponse } from '@shared/health';
import { Button } from '@/components/ui/button';

type HealthState =
  | { status: 'loading' }
  | { status: 'ready'; data: HealthResponse }
  | { status: 'error'; message: string };

function App() {
  const [health, setHealth] = useState<HealthState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const res = await fetch('/api/health', { signal: controller.signal });
        if (!res.ok) throw new Error(`/api/health returned ${res.status}`);
        const data = healthResponseSchema.parse(await res.json());
        setHealth({ status: 'ready', data });
      } catch (err) {
        if (controller.signal.aborted) return;
        setHealth({
          status: 'error',
          message: err instanceof Error ? err.message : 'unknown error',
        });
      }
    })();

    return () => controller.abort();
  }, [attempt]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50 p-8 text-slate-900">
      <h1 className="text-2xl font-semibold">Ripple</h1>
      <p className="text-sm text-slate-500">M0: repo &amp; toolchain scaffold</p>

      {health.status === 'loading' && <p>Checking API…</p>}
      {health.status === 'ready' && (
        <p className="text-sm">
          API OK — env <code>{health.data.env}</code> at{' '}
          <code>{health.data.timestamp}</code>
        </p>
      )}
      {health.status === 'error' && (
        <p className="text-sm text-red-600">API error: {health.message}</p>
      )}

      <Button
        onClick={() => {
          setHealth({ status: 'loading' });
          setAttempt((n) => n + 1);
        }}
      >
        Recheck
      </Button>
    </main>
  );
}

export default App;
