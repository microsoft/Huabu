import { Loader2 } from 'lucide-react';

import { cn } from './cn';

type SpinnerSize = 'xs' | 'sm' | 'md';

interface SpinnerProps {
  /** xs = 12px, sm = 16px (default), md = 18px */
  size?: SpinnerSize;
  className?: string;
}

const sizeMap: Record<SpinnerSize, number> = {
  xs: 12,
  sm: 16,
  md: 18,
};

export function Spinner({ size = 'sm', className }: SpinnerProps) {
  return (
    <Loader2 size={sizeMap[size]} className={cn('animate-spin', className)} />
  );
}
