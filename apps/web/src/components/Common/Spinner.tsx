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
  // The rotation lives on a plain HTML <span> rather than on the <svg>
  // itself: Chromium does not reliably promote SVG transform animations to
  // the compositor, so an `animate-spin` applied directly to the icon keeps
  // running on the main thread and freezes whenever a long synchronous task
  // (e.g. building a large canvas) blocks it. Spinning a composited HTML
  // element instead — `will-change: transform` forces its own layer — lets
  // the GPU/compositor thread drive the rotation, so it keeps turning even
  // while the main thread is janked. The icon inside is static and just
  // rides along.
  return (
    <span
      className={cn(
        'inline-flex animate-spin [will-change:transform]',
        className,
      )}
    >
      <Loader2 size={sizeMap[size]} />
    </span>
  );
}
