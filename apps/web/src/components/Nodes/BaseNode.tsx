import { Handle, Position, NodeResizer, NodeToolbar } from '@xyflow/react';
import { clsx } from 'clsx';
import { GripVertical } from 'lucide-react';
import React, { memo } from 'react';

import { ColorSelector } from '@/components/Common/ColorSelector.tsx';

export type NodeDataProps = {
  src?: string;
  content?: string;
  label?: string;
  color?: string;
  isExpanded?: boolean;
  settings?: object;

  [key: string]: any;
};

interface NodeWrapperProps {
  id: string;
  data: NodeDataProps;
  selected?: boolean;

  children: React.ReactNode;
  className?: string;
  minWidth?: number;
  minHeight?: number;
  toolbar?: React.ReactNode;

  keepAspectRatio?: boolean;
}

export const NodeWrapper = memo(
  ({
    id,
    data,
    selected,
    children,
    className,
    minWidth,
    minHeight,
    toolbar,
    keepAspectRatio = false,
  }: NodeWrapperProps) => {
    return (
      <>
        <NodeResizer
          color="#e6e6e6"
          isVisible={selected}
          minWidth={minWidth}
          minHeight={minHeight}
          keepAspectRatio={keepAspectRatio}
        />
        <NodeToolbar
          isVisible={selected}
          position={Position.Top}
          offset={6}
          className="border-border shadow-bottom flex items-center gap-3 rounded-md border bg-white px-2 py-1"
        >
          {toolbar}
          <ColorSelector nodeId={id} currentColor={data.color} />
        </NodeToolbar>

        <div
          className={clsx(
            'group relative flex h-full w-full flex-col rounded-xl border transition-all duration-120',
            data?.color ? data.color : 'bg-white',
            selected
              ? 'border-theme-500 ring-theme-100 border ring'
              : 'hover:border-border border-white',
            className,
          )}
        >
          <div
            className={clsx(
              'text-icon hover:text-main absolute top-0 -left-[24px] flex h-6 w-4 cursor-grab items-center justify-center rounded opacity-0 transition-opacity',
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

          <div className="flex-1 overflow-hidden p-0">{children}</div>

          <Handle
            type="target"
            position={Position.Top}
            className="!bg-theme-500 !h-1 !w-1 !border-none opacity-0 transition-opacity group-hover:opacity-100"
          />
          <Handle
            type="source"
            position={Position.Right}
            className="!bg-theme-500 !h-1 !w-1 !border-none opacity-0 transition-opacity group-hover:opacity-100"
          />
          <Handle
            type="source"
            position={Position.Bottom}
            className="!bg-theme-500 !h-1 !w-1 !border-none opacity-0 transition-opacity group-hover:opacity-100"
          />
          <Handle
            type="target"
            position={Position.Left}
            className="!bg-theme-500 !h-1 !w-1 !border-none opacity-0 transition-opacity group-hover:opacity-100"
          />
        </div>
      </>
    );
  },
);
