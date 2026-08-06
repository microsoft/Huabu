// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Button, type ButtonProps } from './Button';
import { cn } from './cn';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TabOption<T extends string = string> {
  value: T;
  label: string;
}

type TabGroupProps<T extends string = string> = {
  options: TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  /** Underlying `<Button>` size. Defaults to `'md'`. */
  size?: ButtonProps['size'];
};

// ─── TabGroup ─────────────────────────────────────────────────────────────────

/**
 * TabGroup — a stateless segmented control for switching between views.
 * Follows the design system §3.4 styling conventions.
 *
 * Usage:
 * ```tsx
 * <TabGroup
 *   options={[{ value: 'canvas', label: 'Canvas' }, { value: 'sources', label: 'Sources' }]}
 *   value={tab}
 *   onChange={setTab}
 * />
 * ```
 */
export function TabGroup<T extends string = string>({
  options,
  value,
  onChange,
  className,
  size = 'md',
}: TabGroupProps<T>) {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      {options.map((option) => (
        <Button
          key={option.value}
          variant="ghost"
          size={size}
          className={
            option.value === value
              ? 'bg-bg-default text-fg-default'
              : 'text-fg-muted hover:text-fg-default'
          }
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}
