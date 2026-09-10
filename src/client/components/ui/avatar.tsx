import * as React from 'react';
import { cn } from '@/lib/utils';

type Presence = 'online' | 'away' | 'offline';

const sizeClasses = {
  sm: 'size-8 text-xs',
  md: 'size-10 text-sm',
  lg: 'size-14 text-lg',
  xl: 'size-20 text-2xl',
} as const;

export interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  name: string;
  size?: keyof typeof sizeClasses;
  presence?: Presence;
  speaking?: boolean;
}

const brandTints = [
  'bg-brand-100 text-brand-700',
  'bg-emerald-100 text-emerald-700',
  'bg-amber-100 text-amber-700',
  'bg-rose-100 text-rose-700',
  'bg-sky-100 text-sky-700',
  'bg-violet-100 text-violet-700',
];

function tintFor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return brandTints[hash % brandTints.length];
}

// Shared initials avatar used by conversation lists, friends, call stage, and
// the header — presence dot and a soft "speaking" ring are opt-in per usage.
export const Avatar = React.forwardRef<HTMLDivElement, AvatarProps>(
  ({ name, size = 'md', presence, speaking, className, ...props }, ref) => {
    const initial = name.trim().slice(0, 1).toUpperCase() || '?';
    return (
      <div ref={ref} className={cn('relative inline-flex shrink-0', className)} {...props}>
        <div
          className={cn(
            'flex items-center justify-center rounded-full font-medium',
            sizeClasses[size],
            tintFor(name),
            speaking && 'ring-2 ring-brand-500 ring-offset-2 ring-offset-surface',
          )}
        >
          {initial}
        </div>
        {presence && (
          <span
            className={cn(
              'absolute right-0 bottom-0 rounded-full border-2 border-surface',
              size === 'sm' ? 'size-2' : 'size-2.5',
              presence === 'online' && 'bg-online',
              presence === 'away' && 'bg-away',
              presence === 'offline' && 'bg-slate-300 dark:bg-slate-600',
            )}
          />
        )}
      </div>
    );
  },
);
Avatar.displayName = 'Avatar';
