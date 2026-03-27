import { GripVertical } from 'lucide-react';

import { Button, type ButtonProps } from './Button';
import { cn } from './cn';

import type { ReactNode } from 'react';

export type DragToCanvasHandleButtonProps = Omit<
  ButtonProps,
  'children' | 'draggable' | 'variant' | 'iconOnly'
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
    : 'h-4.5 w-4.5 p-px! text-fg-subtle hover:text-fg-default flex cursor-grab items-center justify-center rounded';

  return (
    <Button
      variant="ghost"
      iconOnly
      aria-label="Drag block to canvas"
      draggable
      className={cn(baseClassName, '[&_svg]:h-auto [&_svg]:w-auto', className)}
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
    </Button>
  );
};
