import { cn } from './cn';
import { SkeletonLines } from './SkeletonLines';
import { Spinner } from './Spinner';

interface LoadingStateProps {
  /** Optional text shown next to (spinner) / below (skeleton) the indicator. */
  message?: string;
  /** Absolute-positioned to fill parent container */
  overlay?: boolean;
  /** Fill the parent container height (h-full). */
  fullScreen?: boolean;
  /**
   * Indicator style. `spinner` (default) renders the brand Lottie
   * spinner — good for page-level / workspace boot / button inline.
   * `skeleton` renders three shimmer bars — preferred for in-node
   * loading (PDF document / page render, web preview fetch, …)
   * because it reads as "content is materialising here" rather than
   * "the app is busy".
   */
  variant?: 'spinner' | 'skeleton';
  className?: string;
}

export function LoadingState({
  message,
  overlay,
  fullScreen,
  variant = 'spinner',
  className,
}: LoadingStateProps) {
  const isSkeleton = variant === 'skeleton';
  return (
    <div
      className={cn(
        'flex items-center justify-center',
        // Spinner sits inline with its message; skeleton bars stack
        // above their message so the bars stay legible.
        isSkeleton ? 'flex-col gap-2' : 'gap-2',
        overlay && 'bg-surface absolute inset-0 z-10',
        fullScreen && 'h-full w-full',
        !overlay && !fullScreen && 'h-full w-full',
        className,
      )}
    >
      {isSkeleton ? (
        <SkeletonLines className="w-full max-w-xs" />
      ) : (
        <Spinner size="md" className="text-fg-subtle" />
      )}
      {message && <span className="text-fg-subtle text-sm">{message}</span>}
    </div>
  );
}
