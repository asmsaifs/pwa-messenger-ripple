import { Link, useSearchParams } from 'react-router-dom';
import { buttonVariants } from '../components/ui/button';
import { InstallButton } from '../components/InstallButton';
import { authErrorMessage } from '../lib/auth-client';
import { cn } from '@/lib/utils';

export function WelcomePage() {
  const [searchParams] = useSearchParams();
  const errorMessage = authErrorMessage(searchParams.get('error'));

  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink">Talk, calmly.</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Voice and text chat with friends, right from Chrome OS — install it, and it works
          offline.
        </p>
      </div>

      {errorMessage && (
        <p className="w-full rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {errorMessage}
        </p>
      )}

      <div className="flex w-full flex-col gap-2">
        <Link to="/signup" className={cn(buttonVariants({ variant: 'default', size: 'lg' }))}>
          Sign up
        </Link>
        <Link
          to={{
            pathname: '/login',
            ...(errorMessage ? { search: `?error=${searchParams.get('error')}` } : {}),
          }}
          className={cn(buttonVariants({ variant: 'outline', size: 'lg' }))}
        >
          Log in
        </Link>
        <InstallButton className="w-full" size="lg" />
      </div>
    </div>
  );
}
