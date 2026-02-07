import { GripVertical } from 'lucide-react';

import { GhostButton, type GhostButtonProps } from './GhostButton';

export type DragToCanvasHandleButtonProps = Omit<
  GhostButtonProps,
  'children' | 'draggable'
> & {
  iconSize?: number;
  className?: string;
};

export const DragToCanvasHandleButton = ({
  iconSize = 16,
  className,
  ...props
}: DragToCanvasHandleButtonProps) => {
  const baseClassName =
    'h-4.5 w-4.5 p-px! text-icon hover:text-main flex cursor-grab items-center justify-center rounded';

  return (
    <GhostButton
      aria-label="Drag block to canvas"
      draggable
      className={[baseClassName, className].filter(Boolean).join(' ')}
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
      <GripVertical size={iconSize} />
    </GhostButton>
  );
};
