// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Lottie from 'lottie-react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import loadingAnimation from '@/assets/loading.json';

import { cn } from './cn';

type LoadingVariant = 'spinner' | 'skeleton' | 'brand';
type LoadingLayout = 'inline' | 'block' | 'overlay' | 'bare';
type LoadingSize = 'xs' | 'sm' | 'md';

interface LoadingProps {
  /** Visual treatment of the loading indicator. */
  variant?: LoadingVariant;
  /** Layout strategy around the indicator. */
  layout?: LoadingLayout;
  /** Indicator size for spinner / brand variants. */
  size?: LoadingSize;
  /** Optional helper text. */
  message?: string;
  /** Number of skeleton lines to render. Defaults to 3. */
  lines?: number;
  className?: string;
  indicatorClassName?: string;
}

const sizeMap: Record<LoadingSize, number> = {
  xs: 12,
  sm: 16,
  md: 18,
};

function SpinnerLoadingIndicator({
  size = 'sm',
  className,
}: {
  size?: LoadingSize;
  className?: string;
}) {
  const { t } = useTranslation();
  // Rotate a plain HTML element instead of the SVG itself so Chromium can
  // promote the transform animation to the compositor during canvas jank.
  return (
    <span
      role="status"
      aria-label={t('status.loading')}
      className={cn(
        'inline-flex animate-spin will-change-transform',
        className,
      )}
    >
      <Loader2 size={sizeMap[size]} />
    </span>
  );
}

function BrandLoadingIndicator({
  size = 'sm',
  className,
}: {
  size?: LoadingSize;
  className?: string;
}) {
  const { t } = useTranslation();
  const px = sizeMap[size];

  return (
    <span
      role="status"
      aria-label={t('status.loading')}
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

function SkeletonLoadingIndicator({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn('skeleton-lines', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton-line" />
      ))}
    </div>
  );
}

export function Loading({
  variant = 'spinner',
  layout = 'block',
  size = 'sm',
  message,
  lines = 3,
  className,
  indicatorClassName,
}: LoadingProps) {
  const isSkeleton = variant === 'skeleton';
  const Tag = layout === 'inline' ? 'span' : 'div';

  const indicator = isSkeleton ? (
    <SkeletonLoadingIndicator
      lines={lines}
      className={cn(
        layout === 'bare' ? className : 'w-full max-w-xs',
        indicatorClassName,
      )}
    />
  ) : variant === 'brand' ? (
    <BrandLoadingIndicator
      size={size}
      className={cn(
        (layout === 'inline' || layout === 'bare') && className,
        indicatorClassName,
      )}
    />
  ) : (
    <SpinnerLoadingIndicator
      size={size}
      className={cn(
        (layout === 'inline' || layout === 'bare') && className,
        indicatorClassName,
      )}
    />
  );

  if (layout === 'bare' || (layout === 'inline' && !message)) return indicator;

  return (
    <Tag
      className={cn(
        'items-center justify-center',
        layout === 'inline' ? 'inline-flex' : 'flex',
        isSkeleton ? 'flex-col gap-2' : 'gap-2',
        layout === 'overlay' && 'bg-surface absolute inset-0 z-10',
        layout === 'block' && 'h-full w-full',
        layout !== 'inline' && className,
      )}
    >
      {indicator}
      {message ? (
        <span className="text-fg-subtle text-sm">{message}</span>
      ) : null}
    </Tag>
  );
}
