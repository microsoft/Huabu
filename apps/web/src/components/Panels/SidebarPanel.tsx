import React from 'react';

interface SidebarPanelProps {
  isCollapsed?: boolean;
  onToggle?: () => void;
  title: string;
  iconCollapsed: React.ReactNode;
  iconExpanded: React.ReactNode;
  children?: React.ReactNode;
}

export const SidebarPanel = ({
  isCollapsed,
  onToggle,
  title,
  iconCollapsed,
  iconExpanded,
  children,
}: SidebarPanelProps) => {
  if (isCollapsed) {
    return (
      <div className="flex h-full flex-col items-center pt-3">
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
    <div className="shadow-bottom flex h-full flex-col rounded-3xl bg-white">
      {/* title */}
      <div className="flex h-10 shrink-0 items-center justify-between px-3">
        <span className="text-sm font-semibold">{title}</span>
        <button
          onClick={onToggle}
          title={`Close ${title}`}
          className="flex cursor-pointer items-center rounded border-none bg-transparent p-1 transition-colors hover:bg-gray-100"
        >
          {iconExpanded}
        </button>
      </div>
      {/* content */}
      <div className="flex-1 overflow-y-auto p-4">{children}</div>
    </div>
  );
};
