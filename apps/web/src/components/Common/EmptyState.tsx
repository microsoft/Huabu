// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { cn } from './cn';

import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon?: ReactNode;
  /** Primary message. */
  message: string;
  /** Optional action rendered below the message (e.g. a Button). */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  message,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center py-20',
        className,
      )}
    >
      {icon ? (
        <div className="flex max-w-full items-start gap-2 text-left">
          <span aria-hidden className="text-fg-subtle mt-0.5 shrink-0">
            {icon}
          </span>
          <p className="text-fg-subtle min-w-0 text-sm">{message}</p>
        </div>
      ) : (
        <p className="text-fg-subtle text-sm">{message}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
