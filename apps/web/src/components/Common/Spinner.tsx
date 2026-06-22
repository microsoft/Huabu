import Lottie from 'lottie-react';

import loadingAnimation from '@/assets/loading.json';

import { cn } from './cn';

type SpinnerSize = 'xs' | 'sm' | 'md';

interface SpinnerProps {
  /** xs = 12px, sm = 16px (default), md = 18px */
  size?: SpinnerSize;
  /**
   * Passed through for layout (margin, alignment, etc.). Text-color
   * utilities like `text-fg-subtle` have no effect here — the Lottie
   * has its own brand palette baked in.
   */
  className?: string;
}

const sizeMap: Record<SpinnerSize, number> = {
  xs: 12,
  sm: 16,
  md: 18,
};

export function Spinner({ size = 'sm', className }: SpinnerProps) {
  const px = sizeMap[size];
  // Wrap in a fixed-size <span> so flex parents lay us out predictably;
  // the Lottie fills it with `width/height: 100%`. lottie-react drives
  // the SVG animation off requestAnimationFrame (main thread) so a long
  // synchronous task on the JS thread will still pause the spinner —
  // an inherent trade-off vs. the old composited-CSS rotation.
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn('inline-flex shrink-0', className)}
      style={{ width: px, height: px }}
    >
      <Lottie
        animationData={loadingAnimation}
        loop
        autoplay
        style={{ width: '100%', height: '100%' }}
      />
    </span>
  );
}
