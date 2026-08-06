// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { forwardRef } from 'react';

import { cn } from './cn';
import { Input } from './Input';

import type { InputProps } from './Input';

export type TextInputType =
  | 'email'
  | 'password'
  | 'search'
  | 'tel'
  | 'text'
  | 'url';

export type TextInputProps = Omit<InputProps, 'size' | 'type'> & {
  /** Visual density of the text field. Defaults to `sm`. */
  size?: 'sm' | 'md';
  /** Restricts this styled primitive to text-like native input types. */
  type?: TextInputType;
  /** Uses the monospace font for commands, paths, and configuration values. */
  mono?: boolean;
};

const SIZE_CLASSES = {
  sm: 'px-2 py-1.5 text-xs',
  md: 'px-2.5 py-1.5 text-sm',
} as const;

/**
 * Standard design-system text field.
 *
 * Use the low-level `Input` directly only when a caller owns all visual
 * styling. Non-text controls such as checkbox, radio, range, and file inputs
 * should use their dedicated component or the native element.
 */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  ({ className, mono = false, size = 'sm', type = 'text', ...props }, ref) => (
    <Input
      ref={ref}
      type={type}
      className={cn(
        'border-edge-default bg-surface text-fg-default placeholder:text-fg-subtle focus:ring-info-light rounded-md border focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        SIZE_CLASSES[size],
        mono && 'font-mono',
        className,
      )}
      {...props}
    />
  ),
);

TextInput.displayName = 'TextInput';
