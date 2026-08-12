// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import React from 'react';

import { Button } from '../Common/Button';

interface SidebarPanelProps {
  isCollapsed?: boolean;
  onToggle?: () => void;
  title: string;
  tabs?: React.ReactNode;
  tools?: React.ReactNode;
  iconCollapsed: React.ReactNode;
  iconExpanded: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  /**
   * When true, skip rendering the panel's own header bar in the expanded state.
   * Useful when the surrounding layout already hosts the collapse / title UI
   * (e.g. the layer panel shares the top header with the app logo).
   * The collapsed-state strip is unaffected so users can still re-expand.
   */
  hideHeader?: boolean;
  /** Uses a denser header when this panel is nested inside another surface. */
  compactHeader?: boolean;
  /** Visually hides a redundant title while preserving its accessible text. */
  hideTitle?: boolean;
}

export const SidebarPanel = ({
  isCollapsed,
  onToggle,
  title,
  tabs,
  tools,
  iconCollapsed,
  iconExpanded,
  children,
  className,
  hideHeader,
  compactHeader,
  hideTitle,
}: SidebarPanelProps) => {
  if (isCollapsed) {
    return (
      <div
        className={clsx(
          'bg-surface flex h-full flex-col items-center pt-3',
          className,
        )}
      >
        <Button
          variant="ghost"
          iconOnly
          onClick={onToggle}
          title={`Expand ${title}`}
          tooltipPlacement="bottom"
        >
          {iconCollapsed}
        </Button>
        <span className="text-fg-muted mt-3 text-xs font-semibold select-none [text-orientation:mixed] [writing-mode:vertical-rl]">
          {title}
        </span>
      </div>
    );
  }

  return (
    <div className={clsx('bg-surface flex h-full flex-col', className)}>
      {/* header */}
      {!hideHeader && (
        <div
          className={clsx(
            'flex shrink-0 items-center justify-between',
            !compactHeader && 'border-edge-default border-b',
            compactHeader ? 'h-9 px-2' : 'h-12 px-3',
          )}
        >
          <div className="text-fg-muted flex min-w-0 flex-1 items-center text-sm font-semibold">
            {hideTitle ? (
              <span className="sr-only">{title}</span>
            ) : tabs ? (
              tabs
            ) : (
              title
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {tools && (
              <div className="text-fg-muted flex items-center">{tools}</div>
            )}
            {tools && onToggle && (
              <span
                aria-hidden
                className="bg-edge-default mx-1 h-4 w-px shrink-0"
              />
            )}
            {/* No collapse control when the host owns collapsing — e.g. a
                preview tab, whose own close control replaces it. */}
            {onToggle && (
              <Button
                variant="ghost"
                iconOnly
                onClick={onToggle}
                title={`Collapse ${title}`}
                tooltipPlacement="bottom"
              >
                {iconExpanded}
              </Button>
            )}
          </div>
        </div>
      )}
      {/* content */}
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
};
