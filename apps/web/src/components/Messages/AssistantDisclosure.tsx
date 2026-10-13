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
 *   - the same chevron treatment (rotates 90° when expanded);
 *   - the same hover / spacing / typography (`text-xs`, `py-0.5`,
 *     `gap-1.5`, `text-fg-muted` …);
 *   - the same click-to-toggle behaviour, including the "no body →
 *     render as a non-interactive row (no chevron, no button)" rule.
 *
 * Consumers stay declarative: pass `icon`, `title`, optional `trailing`
 * (extra controls rendered after the chevron), and `children` for the
 * expanded body. Body styling is configurable via `bodyClassName` so
 * the few cards that want a left rule / different indent can opt in
 * without forking the shell.
 */

import { ChevronRight } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { Button } from '../Common/Button';

export const ASSISTANT_ROW_CLASS_NAME =
  'text-fg-muted relative ml-1 px-4 py-0.5 text-xs';

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
  /** Controlled state for a caller-owned expansion policy. */
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Show only the body without remounting it when a summary becomes necessary. */
  showHeader?: boolean;
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
  collapsed,
  onCollapsedChange,
  showHeader = true,
  collapseSignal,
  bodyClassName = '',
}: AssistantDisclosureProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(defaultCollapsed);
  const isCollapsed = collapsed ?? internalCollapsed;
  const bodyId = useId();

  // Auto-collapse once when collapseSignal transitions false → true (e.g. a
  // tool card that was open while executing and should fold on completion).
  // Initialise the ref to the *current* signal so already-done tools on
  // initial render don't fire the effect spuriously.
  const prevCollapseRef = useRef(collapseSignal);
  useEffect(() => {
    if (collapseSignal && !prevCollapseRef.current) {
      setInternalCollapsed(true);
    }
    prevCollapseRef.current = collapseSignal;
  }, [collapseSignal]);
  const expandable = children !== undefined && children !== null;

  const iconSlot = icon ? (
    <span className="absolute top-1/2 left-0 flex size-3 -translate-y-1/2 items-center justify-center">
      {icon}
    </span>
  ) : null;
  const titleText = (
    <span className="min-w-0 truncate" title={titleTooltip}>
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
        {showHeader && (
          <div
            className={`${ASSISTANT_ROW_CLASS_NAME} hover:bg-hover flex items-center gap-1.5 rounded-md transition-colors`}
          >
            {expandable ? (
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={!isCollapsed}
                aria-controls={bodyId}
                onClick={() => {
                  if (collapsed === undefined) {
                    setInternalCollapsed(!isCollapsed);
                  }
                  onCollapsedChange?.(!isCollapsed);
                }}
                className="focus-visible:outline-info min-w-0 flex-1 justify-start rounded-none p-0 text-left font-normal focus-visible:outline-1"
              >
                {iconSlot}
                {titleText}
                {chevron}
              </Button>
            ) : (
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                {iconSlot}
                {titleText}
              </div>
            )}
            {trailing}
          </div>
        )}
        {expandable && (!showHeader || !isCollapsed) && (
          <div
            id={bodyId}
            className={`text-fg-muted text-xs ${showHeader ? 'mt-1' : ''} ${bodyClassName}`}
          >
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
