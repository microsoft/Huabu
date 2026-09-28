// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Loader2 } from 'lucide-react';

import { cn } from './cn';

export type SpinnerSize = 'xs' | 'sm' | 'md';

const spinnerSize: Record<SpinnerSize, number> = {
  xs: 12,
  sm: 16,
  md: 18,
};

/** A centred loading indicator with a stable square rotation box. */
export function Spinner({
  size = 'sm',
  className,
  label,
}: {
  size?: SpinnerSize;
  className?: string;
  label?: string;
}) {
  const pixels = spinnerSize[size];

  return (
    <span
      data-loading-spinner
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        'inline-grid shrink-0 place-items-center leading-none',
        className,
      )}
      style={{ width: pixels, height: pixels }}
    >
      <span className="grid size-full origin-center animate-spin place-items-center will-change-transform">
        <Loader2 aria-hidden size={pixels} />
      </span>
    </span>
  );
}
