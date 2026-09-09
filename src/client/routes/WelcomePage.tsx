import { Link } from 'react-router-dom';
import { buttonVariants } from '../components/ui/button';
import { InstallButton } from '../components/InstallButton';
import { cn } from '@/lib/utils';

export function WelcomePage() {
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <div>
        <h1 className="text-2xl font-semibold">Ripple</h1>
        <p className="mt-2 text-sm text-slate-500">
          Voice and text chat with friends, right from Chrome OS — install it, and it works
          offline.
        </p>
      </div>

      <div className="flex w-full flex-col gap-2">
        <Link to="/signup" className={cn(buttonVariants({ variant: 'default' }))}>
          Sign up
        </Link>
        <Link to="/login" className={cn(buttonVariants({ variant: 'outline' }))}>
          Log in
        </Link>
        <InstallButton />
      </div>
    </div>
  );
}
