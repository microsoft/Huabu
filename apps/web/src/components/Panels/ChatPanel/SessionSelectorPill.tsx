// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `SessionSelectorPill` — the shared presentation contract for the compact
 * dropdown "pills" rendered in the ChatPanel toolbar row by both
 * {@link BuiltinSessionSelectors} and {@link AcpSessionSelectors}.
 *
 * It is a deliberately thin wrapper over {@link Select}: it pins the visual
 * props (`ghost` / `pill` / `neutral` / `sm`, top-left panel alignment, and the
 * compact trigger padding) so both agent kinds render an *identical* toolbar
 * row by construction rather than by hand-synced comments. Data adaptation
 * (built-in `LLMModelInfo` vs ACP `configOptions` / legacy lists) stays in each
 * caller — this component intentionally carries no backend semantics.
 *
 * Only the data-relevant props are forwarded; `className` is *appended* to the
 * compact trigger class (via `cn`'s tailwind-merge) so a caller can still tweak
 * the trigger without losing the shared baseline.
 */

import { cn } from '../../Common/cn';
import { Select, type SelectOption } from '../../Common/Select';

// Compact trigger: tighter than the default `size="sm"` Button so the toolbar
// row doesn't wrap when an agent publishes 3+ pills. Wins over the size class
// via `tailwind-merge` in `Select`'s `cn()`.
const COMPACT_TRIGGER_CLASS = 'px-1.5 py-0.5 gap-1';

interface SessionSelectorPillProps<T extends string> {
  options: SelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Tooltip / accessible name for the trigger. */
  title?: string;
  /** Extra trigger classes, appended to the shared compact class. */
  className?: string;
}

export function SessionSelectorPill<T extends string = string>({
  options,
  value,
  onChange,
  disabled = false,
  title,
  className,
}: SessionSelectorPillProps<T>) {
  return (
    <Select<T>
      options={options}
      value={value}
      onChange={onChange}
      disabled={disabled}
      title={title}
      variant="ghost"
      shape="pill"
      tone="neutral"
      size="sm"
      align="top-left"
      className={cn(COMPACT_TRIGGER_CLASS, className)}
    />
  );
}
