// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { GripVertical } from 'lucide-react';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
  const baseClassName = children
    ? 'cursor-grab active:cursor-grabbing'
    : 'h-4.5 w-4.5 p-px! text-fg-subtle hover:text-fg-default flex cursor-grab items-center justify-center rounded';

  return (
    <Button
      variant="ghost"
      iconOnly
      aria-label={t('toolbar.dragBlockToCanvas')}
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
