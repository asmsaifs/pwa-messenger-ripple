import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// shadcn/ui's standard class-merging helper.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
