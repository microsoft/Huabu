// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * AssistantDisclosure — shared shell for the collapsible one-line
 * cards that appear inside an assistant turn (thinking summary,
 * prepared-prompt summary, ACP tool calls, …).
 *
 * Centralising the shell means every consumer naturally gets:
 *   - the same 12 × 12 leading-icon slot, so titles align across cards
 *     regardless of whether the consumer passes a small dot, a
 *     `Loader2`, or a full lucide icon;
 *   - the same chevron treatment (10 px, rotates 90° when expanded);
 *   - the same hover / spacing / typography (`text-xs`, `py-0.5`,
 *     `gap-1.5`, `text-fg-muted` …);
 *   - the same click-to-toggle behaviour, including the "no body →
 *     render as a non-interactive row (no chevron, no button)" rule.
 *
 * Consumers stay declarative: pass `icon`, `title`, optional `trailing`
 * (extra controls rendered after the chevron — used by
 * `SpaceCommandCard`'s revert/keep buttons), and `children` for the
 * expanded body. Body styling is configurable via `bodyClassName` so
 * the few cards that want a left rule / different indent can opt in
 * without forking the shell.
 */

import { ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

interface AssistantDisclosureProps {
  /**
   * Leading marker (icon, spinner, dot, …). Rendered inside a fixed
   * 12 × 12 box and centred, so any glyph size visually agrees with
   * the standard 12 px lucide icons used elsewhere.
   */
  icon: ReactNode;
  /** Single-line title; truncates with ellipsis when overflowing. */
  title: ReactNode;
  /**
   * Optional plain-text tooltip for the title. Useful when the title
   * may be truncated and the consumer wants the full text accessible
   * via a native hover tooltip — particularly when the disclosure has
   * no body to fall back on.
   */
  titleTooltip?: string;
  /**
   * Optional trailing slot, rendered after the chevron inside the
   * header row. Use for action buttons that must stay visible while
   * collapsed.
   */
  trailing?: ReactNode;
  /**
   * Body shown when the disclosure is expanded. Omit to render the
   * header as a non-interactive row (no chevron, no toggle).
   */
  children?: ReactNode;
  /** Initial collapsed state. Defaults to `true`. */
  defaultCollapsed?: boolean;
  /**
   * When this prop transitions from `false` → `true`, the disclosure
   * auto-collapses. The user can still re-expand manually afterwards.
   * Intended for tool cards that start expanded while executing and
   * should fold once the tool completes.
   */
  collapseSignal?: boolean;
  /** Extra classes for the body wrapper (e.g. left rule, indent). */
  bodyClassName?: string;
}

export function AssistantDisclosure({
  icon,
  title,
  titleTooltip,
  trailing,
  children,
  defaultCollapsed = true,
  collapseSignal,
  bodyClassName = '',
}: AssistantDisclosureProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

  // Auto-collapse once when collapseSignal transitions false → true (e.g. a
  // tool card that was open while executing and should fold on completion).
  // Initialise the ref to the *current* signal so already-done tools on
  // initial render don't fire the effect spuriously.
  const prevCollapseRef = useRef(collapseSignal);
  useEffect(() => {
    if (collapseSignal && !prevCollapseRef.current) {
      setIsCollapsed(true);
    }
    prevCollapseRef.current = collapseSignal;
  }, [collapseSignal]);
  const expandable = children !== undefined && children !== null;

  const iconSlot = (
    <span className="flex size-3 shrink-0 items-center justify-center">
      {icon}
    </span>
  );
  const titleText = (
    <span className="min-w-0 flex-1 truncate" title={titleTooltip}>
      {title}
    </span>
  );
  const chevron = expandable ? (
    <ChevronRight
      size={10}
      className={`text-fg-muted/50 shrink-0 transition-transform ${
        !isCollapsed ? 'rotate-90' : ''
      }`}
    />
  ) : null;

  return (
    <div className="flex justify-start">
      <div className="w-full min-w-0">
        <div className="text-fg-muted hover:bg-hover flex w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-xs transition-colors">
          {expandable ? (
            <button
              type="button"
              onClick={() => setIsCollapsed((prev) => !prev)}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            >
              {iconSlot}
              {titleText}
              {chevron}
            </button>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              {iconSlot}
              {titleText}
            </div>
          )}
          {trailing}
        </div>
        {expandable && !isCollapsed && (
          <div className={`text-fg-muted mt-1 text-xs ${bodyClassName}`}>
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
