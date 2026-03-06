import React from 'react';

import { GhostButton } from '../Common/GhostButton';

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
}: SidebarPanelProps) => {
  if (isCollapsed) {
    return (
      <div
        className={`flex h-full flex-col items-center bg-white pt-3 ${className}`}
      >
        <GhostButton onClick={onToggle} title={`Expand ${title}`}>
          {iconCollapsed}
        </GhostButton>
        <span className="mt-3 text-xs font-semibold text-gray-500 select-none [text-orientation:mixed] [writing-mode:vertical-rl]">
          {title}
        </span>
      </div>
    );
  }

  return (
    <div className={`flex h-full flex-col bg-white ${className}`}>
      {/* header */}
      <div className="border-border flex h-12 shrink-0 items-center justify-between border-b px-3">
        <div className="text-muted-foreground flex min-w-0 flex-1 items-center text-sm font-semibold">
          {tabs ? tabs : title}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {tools && (
            <div className="text-muted-foreground flex items-center">
              {tools}
            </div>
          )}
          <GhostButton
            className="text-muted-foreground"
            onClick={onToggle}
            title={`Collapse ${title}`}
          >
            {iconExpanded}
          </GhostButton>
        </div>
      </div>
      {/* content */}
      <div className="flex-1 overflow-y-auto p-3">{children}</div>
    </div>
  );
};
