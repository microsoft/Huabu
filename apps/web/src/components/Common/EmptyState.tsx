// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { cn } from './cn';

import type { ReactNode } from 'react';

interface EmptyStateProps {
  /** Primary message. */
  message: string;
  /** Optional action rendered below the message (e.g. a Button). */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ message, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center py-20',
        className,
      )}
    >
      <p className="text-fg-subtle text-sm">{message}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
