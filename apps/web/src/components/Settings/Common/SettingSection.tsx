// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ChevronDown } from 'lucide-react';
import React, { useId, useRef, useState } from 'react';

import { Button } from '@/components/Common/Button';
import { dismissPopoversWithin } from '@/components/Common/Popover';

import { SettingLabel } from './SettingLabel';

interface SettingSectionProps {
  /** Section heading shown above the card. Omit to render a bare card with no heading. */
  title?: string;
  /** Optional action outside the card, beside the section heading. */
  action?: React.ReactNode;
  /** Whether the entire capability or group may be left unconfigured. */
  optional?: boolean;
  children: React.ReactNode;
  /**
   * When true, renders a ghost chevron next to the title and lets the
   * user collapse the card by clicking the heading. Defaults to `false`
   * so existing non-collapsible sections keep their current behaviour.
   */
  collapsible?: boolean;
  /**
   * Initial collapsed state when {@link collapsible} is true. Defaults
   * to `false` (i.e. expanded on first render).
   */
  defaultCollapsed?: boolean;
  /** Keep content mounted after its first expansion so collapsing preserves drafts. */
  keepMounted?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

/**
 * A titled settings section. The title sits outside the card, and the children
 * (typically {@link SettingRow}s) are rendered inside a single rounded card
 * with dividers automatically applied between rows.
 *
 * Pass {@link collapsible} to turn the heading into a toggle button with a
 * chevron icon; the card hides when collapsed.
 */
export const SettingSection: React.FC<SettingSectionProps> = ({
  title,
  action,
  optional = false,
  children,
  collapsible = false,
  defaultCollapsed = false,
  keepMounted = false,
  onCollapsedChange,
}) => {
  const contentId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [hasExpanded, setHasExpanded] = useState(
    !collapsible || !defaultCollapsed,
  );
  const isCollapsed = collapsible && collapsed;

  return (
    <section
      className={`[container-type:inline-size] ${isCollapsed ? 'mb-2' : 'mb-4'} last:mb-0`}
    >
      {(title || action) && (
        <div
          className={
            collapsible || action
              ? `flex flex-wrap items-center gap-2 ${isCollapsed ? '' : 'mb-1.5'}`
              : undefined
          }
        >
          {title &&
            (collapsible ? (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => {
                  const next = !collapsed;
                  if (next && contentRef.current) {
                    dismissPopoversWithin(contentRef.current);
                  }
                  setCollapsed(next);
                  if (!next) setHasExpanded(true);
                  onCollapsedChange?.(next);
                }}
                aria-expanded={!collapsed}
                aria-controls={contentId}
                className={`text-fg-muted enabled:hover:text-fg-default focus-visible:outline-info min-h-8 ${action ? 'min-w-[min(100%,12rem)]' : 'min-w-0'} flex-1 justify-start gap-2 px-2 py-1 text-left text-[13px] leading-5 font-medium [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2`}
              >
                <ChevronDown
                  size={12}
                  aria-hidden="true"
                  className={`shrink-0 transition-transform motion-reduce:transition-none ${collapsed ? '-rotate-90' : ''}`}
                />
                <SettingLabel optional={optional}>{title}</SettingLabel>
              </Button>
            ) : (
              <h4
                className={`text-fg-muted ${action ? '' : 'mb-1.5'} px-0.5 text-[13px] font-medium`}
              >
                <SettingLabel optional={optional}>{title}</SettingLabel>
              </h4>
            ))}
          {action && <div className="ml-auto shrink-0">{action}</div>}
        </div>
      )}
      {(!isCollapsed || (keepMounted && hasExpanded)) && (
        <div
          ref={contentRef}
          id={contentId}
          hidden={isCollapsed}
          className="bg-surface divide-edge-default border-edge-default divide-y overflow-hidden rounded-[10px] border"
        >
          {children}
        </div>
      )}
    </section>
  );
};
