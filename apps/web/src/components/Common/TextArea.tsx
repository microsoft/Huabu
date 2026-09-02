// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { forwardRef } from 'react';

import { cn } from './cn';

import type { TextareaHTMLAttributes } from 'react';

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  mono?: boolean;
};

/** Standard design-system multiline text field. */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(
  ({ className, mono = false, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'border-edge-default bg-surface text-fg-default placeholder:text-fg-subtle focus:ring-info-light min-h-20 resize-y rounded-md border px-2 py-1.5 text-xs focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        mono && 'font-mono',
        className,
      )}
      {...props}
    />
  ),
);

TextArea.displayName = 'TextArea';
