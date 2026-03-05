import clsx from 'clsx';
import { GripVertical } from 'lucide-react';

import { GhostButton, type GhostButtonProps } from './GhostButton';

import type { ReactNode } from 'react';

export type DragToCanvasHandleButtonProps = Omit<
  GhostButtonProps,
  'children' | 'draggable'
> & {
  iconSize?: number;
  className?: string;
  children?: ReactNode;
};

export const DragToCanvasHandleButton = ({
  iconSize = 16,
  className,
  children,
  ...props
}: DragToCanvasHandleButtonProps) => {
  const baseClassName = children
    ? 'cursor-grab active:cursor-grabbing'
    : 'h-4.5 w-4.5 p-px! text-icon hover:text-main flex cursor-grab items-center justify-center rounded';

  return (
    <GhostButton
      aria-label="Drag block to canvas"
      draggable
      className={clsx(baseClassName, className)}
      onMouseDown={(e) => {
        // Do not call preventDefault here; it can prevent native drag from starting.
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      {...props}
    >
      <GripVertical size={iconSize} className="shrink-0" />
      {children}
    </GhostButton>
  );
};
