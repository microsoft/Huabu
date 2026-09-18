// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * A single consistent presentation for an immutable Profile field shown in
 * the edit editors (Agent, launch command, harness, working directory).
 *
 * Every non-editable value renders through this so the two editor forms
 * share one read-only look instead of drifting into bordered boxes,
 * disabled inputs, and helper-text variants.
 */

import { cn } from '@/components/Common/cn';

export function ReadOnlyField({
  value,
  mono = false,
}: {
  value: string;
  /** Render command/path-like values in a monospace, breakable style. */
  mono?: boolean;
}) {
  return (
    <div
      className={cn(
        'border-edge-default bg-bg-default text-fg-muted rounded border px-2 py-1 text-xs',
        mono && 'font-mono break-all',
      )}
    >
      {value}
    </div>
  );
}
