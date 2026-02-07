import { type Node, type NodeProps } from '@xyflow/react';
import { ArrowUpRight, Shrink, SlidersHorizontal } from 'lucide-react';

import { NodeWrapper, type NodeDataProps } from './NodeWrapper.tsx';

type ImageNodeData = NodeDataProps & {};
export type ImageNodeType = Node<ImageNodeData, 'image'>;

export const ImageNode = ({ id, data, selected }: NodeProps<ImageNodeType>) => {
  const ImageToolbar = (
    <div className="flex w-full items-center justify-between gap-4">
      {/*source*/}
      <a
        href={data?.src}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="nodrag text-muted-foreground hover:text-theme-500 flex flex-1 cursor-pointer items-center gap-1 overflow-hidden text-xs font-medium transition-colors"
      >
        <span className="truncate">
          Source: {data?.src || 'Unknown Source'}
        </span>
        <ArrowUpRight size={12} strokeWidth={2} />
      </a>

      {/*tools*/}
      <div className="text-muted-foreground flex items-center gap-2">
        <div className="bg-border h-3 w-px" />

        <button className="hover:text-main">
          <Shrink size={12} />
        </button>

        <button className="hover:text-main">
          <SlidersHorizontal size={12} />
        </button>
      </div>
    </div>
  );

  return (
    <NodeWrapper
      id={id}
      data={data}
      selected={selected}
      toolbar={ImageToolbar}
      keepAspectRatio={true}
    >
      <div className="flex h-full flex-col">
        <div className="relative h-full w-full overflow-hidden">
          {data?.src ? (
            <img
              src={data.src}
              alt={data.label || 'Node image'}
              className="pointer-events-none h-full w-full rounded border-0 object-contain"
            />
          ) : (
            <div className="text-muted-foreground flex h-full w-full items-center justify-center text-sm">
              No Image Source
            </div>
          )}
        </div>
      </div>
    </NodeWrapper>
  );
};
