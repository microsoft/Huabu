// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { forwardRef } from 'react';

import { cn } from './cn';
import { Tooltip } from './Tooltip';

import type { InputHTMLAttributes } from 'react';

export type InputProps = {
  className?: string;
  wrapperClassName?: string;
  /** Distance in px between the input and the tooltip. Defaults to 8. */
  tooltipOffset?: number;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'className'>;

/**
 * A drop-in replacement for <input> that renders the `title` prop using the
 * shared Tooltip component instead of the native browser tooltip.
 * Supports className merging via `cn()` (tailwind-merge).
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, wrapperClassName, tooltipOffset, title, ...props }, ref) => {
    const inputEl = <input ref={ref} className={cn(className)} {...props} />;

    return title ? (
      <Tooltip
        content={title}
        wrapperClassName={wrapperClassName}
        offset={tooltipOffset}
      >
        {inputEl}
      </Tooltip>
    ) : (
      inputEl
    );
  },
);

Input.displayName = 'Input';
