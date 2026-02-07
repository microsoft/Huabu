import { Handle, Position, NodeResizer, NodeToolbar } from '@xyflow/react';
import { clsx } from 'clsx';
import { GripVertical } from 'lucide-react';
import React, { memo } from 'react';

export type NodeStyle = {
  backgroundColor?: string;
  textColor?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
};

export type NodeDataProps = {
  src?: string;
  content?: string;
  label?: string;

  style?: NodeStyle;

  isExpanded?: boolean;
  settings?: object;
  [key: string]: unknown;
};

interface NodeWrapperProps {
  id: string;
  data: NodeDataProps;
  selected?: boolean;

  allowOverflow?: boolean;

  children: React.ReactNode;
  className?: string;
  minWidth?: number;
  minHeight?: number;
  toolbar?: React.ReactNode;

  keepAspectRatio?: boolean;
  resizable?: boolean;

  onDoubleClick?: React.MouseEventHandler<HTMLDivElement>;
}

export const NodeWrapper = memo(
  ({
    data,
    selected,
    children,
    className,
    minWidth,
    minHeight,
    toolbar,
    keepAspectRatio = false,
    resizable = true,

    allowOverflow = false,

    onDoubleClick,
  }: NodeWrapperProps) => {
    return (
      <>
        <NodeResizer
          color="#e6e6e6"
          isVisible={selected && resizable}
          minWidth={minWidth}
          minHeight={minHeight}
          keepAspectRatio={keepAspectRatio}
        />
        <NodeToolbar
          isVisible={selected}
          position={Position.Top}
          offset={12}
          className="border-border shadow-bottom flex h-8 items-center gap-3 rounded-md border bg-white px-2 py-1"
        >
          {toolbar}
        </NodeToolbar>

        <div
          className={clsx(
            'group relative flex h-full w-full flex-col rounded border-0 transition-all duration-120',
            data.style?.backgroundColor
              ? data.style?.backgroundColor
              : 'bg-transparent',
            selected ? 'ring-theme-500 ring' : 'ring-border hover:ring',
            className,
          )}
          onDoubleClick={onDoubleClick}
        >
          <div
            className={clsx(
              'text-icon hover:text-main absolute top-0 -left-[18px] flex h-6 w-4 cursor-grab items-center justify-center rounded opacity-0 transition-opacity',
              'group-hover:opacity-100',
            )}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/json', JSON.stringify(data));
              e.dataTransfer.effectAllowed = 'copyMove';
            }}
          >
            <GripVertical size={16} />
          </div>

          <div
            className={clsx(
              'flex-1 p-0',
              allowOverflow ? 'overflow-visible' : 'overflow-hidden',
            )}
          >
            {children}
          </div>

          <Handle
            type="target"
            position={Position.Top}
            className="!bg-theme-500 !-top-1 !h-1 !w-1 !border-none opacity-0 transition-opacity group-hover:opacity-100"
          />
          <Handle
            type="source"
            position={Position.Right}
            className="!bg-theme-500 !-right-1 !h-1 !w-1 !border-none opacity-0 transition-opacity group-hover:opacity-100"
          />
          <Handle
            type="source"
            position={Position.Bottom}
            className="!bg-theme-500 !-bottom-1 !h-1 !w-1 !border-none opacity-0 transition-opacity group-hover:opacity-100"
          />
          <Handle
            type="target"
            position={Position.Left}
            className="!bg-theme-500 !-left-1 !h-1 !w-1 !border-none opacity-0 transition-opacity group-hover:opacity-100"
          />
        </div>
      </>
    );
  },
);
