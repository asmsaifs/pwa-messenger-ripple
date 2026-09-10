import { Link } from 'react-router-dom';
import { Logo } from '../components/Logo';

export function NotFoundPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-surface-sunken p-6 text-center">
      <Logo iconClassName="size-8" className="gap-2.5 [&_span]:text-xl" />
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">Page not found</h1>
        <Link to="/" className="mt-1 inline-block text-sm text-brand-600 hover:underline dark:text-brand-400">
          Go home
        </Link>
      </div>
    </div>
  );
}
