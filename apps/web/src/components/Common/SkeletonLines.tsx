import { cn } from './cn';

interface SkeletonLinesProps {
  /** Number of shimmer bars to render. Defaults to 3. */
  lines?: number;
  className?: string;
}

/**
 * Animated skeleton placeholder with shimmer bars.
 * Uses the `.skeleton-lines` / `.skeleton-line` CSS classes from index.css.
 */
export function SkeletonLines({ lines = 3, className }: SkeletonLinesProps) {
  return (
    <div className={cn('skeleton-lines', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton-line" />
      ))}
    </div>
  );
}
