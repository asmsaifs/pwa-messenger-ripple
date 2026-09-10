import { cn } from '@/lib/utils';

// Icon mark mirrors public/favicon.svg (concentric ripple) so the in-app
// header/logo and the browser-tab/PWA icon read as the same brand.
export function LogoMark({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={cn('size-6 text-brand-500', className)} aria-hidden="true">
      <circle cx="12" cy="12" r="3" fill="currentColor" />
      <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="2" opacity="0.55" />
      <circle cx="12" cy="12" r="11" stroke="currentColor" strokeWidth="2" opacity="0.25" />
    </svg>
  );
}

export function Logo({
  className,
  iconClassName,
}: {
  className?: string | undefined;
  iconClassName?: string | undefined;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <LogoMark className={iconClassName} />
      <span className="font-display text-base font-bold tracking-tight text-ink">Ripple</span>
    </span>
  );
}
