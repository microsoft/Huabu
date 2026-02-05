import React from 'react';

interface SidebarPanelProps {
  isCollapsed?: boolean;
  onToggle?: () => void;
  title: React.ReactNode;
  tools: React.ReactNode;
  iconCollapsed: React.ReactNode;
  iconExpanded: React.ReactNode;
  children?: React.ReactNode;
}

export const SidebarPanel = ({
  isCollapsed,
  onToggle,
  title,
  tools,
  iconCollapsed,
  iconExpanded,
  children,
}: SidebarPanelProps) => {
  if (isCollapsed) {
    return (
      <div className="flex h-full flex-col items-center bg-white pt-3">
        <button
          onClick={onToggle}
          title={`Open ${title}`}
          className="cursor-pointer rounded-md border-none bg-transparent p-2 transition-colors hover:bg-gray-200"
        >
          {iconCollapsed}
        </button>
        <span className="mt-3 text-xs font-semibold text-gray-500 select-none [text-orientation:mixed] [writing-mode:vertical-rl]">
          {title}
        </span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-white">
      {/* title */}
      <div className="border-border flex h-12 shrink-0 items-center justify-between border-b px-3">
        <div className="flex min-w-0 flex-1 items-center">{title}</div>
        <div className="flex shrink-0 items-center gap-1">
          {tools && (
            <div className="text-secondary flex items-center">{tools}</div>
          )}
          <button
            onClick={onToggle}
            title="Close Panel"
            className="text-secondary hover:text-main flex h-7 w-7 cursor-pointer items-center justify-center rounded border-none bg-transparent transition-colors hover:bg-gray-100"
          >
            {iconExpanded}
          </button>
        </div>
      </div>
      {/* content */}
      <div className="flex-1 overflow-y-auto p-4">{children}</div>
    </div>
  );
};
