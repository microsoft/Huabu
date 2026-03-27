import { cn } from './cn';
import { Spinner } from './Spinner';

interface LoadingStateProps {
  /** Optional text shown next to the spinner */
  message?: string;
  /** Absolute-positioned to fill parent container */
  overlay?: boolean;
  /** Full viewport height (h-screen) */
  fullScreen?: boolean;
  className?: string;
}

export function LoadingState({
  message,
  overlay,
  fullScreen,
  className,
}: LoadingStateProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-center gap-2',
        overlay && 'bg-surface absolute inset-0 z-10',
        fullScreen && 'h-screen',
        !overlay && !fullScreen && 'h-full w-full',
        className,
      )}
    >
      <Spinner size="md" className="text-fg-subtle" />
      {message && <span className="text-fg-subtle text-sm">{message}</span>}
    </div>
  );
}
