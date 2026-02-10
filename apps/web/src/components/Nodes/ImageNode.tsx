import { type Node, type NodeProps } from '@xyflow/react';
import { ArrowUpRight, Fullscreen, ImageIcon } from 'lucide-react';

import useCanvasStore from '@/store/canvasStore.ts';

import { NodeWrapper } from './NodeWrapper.tsx';
import { GhostButton } from '../Common/GhostButton.tsx';

import type { NodeDataProps } from './types.ts';

type ImageNodeData = NodeDataProps & {};
export type ImageNodeType = Node<ImageNodeData, 'image'>;

export const ImageNode = ({ id, data, selected }: NodeProps<ImageNodeType>) => {
  const openExpanded = useCanvasStore((s) => s.openExpanded);

  const ImageToolbar = (
    <div className="flex w-full items-center justify-between gap-2">
      {/*source*/}
      <a
        href={data?.src}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="nodrag text-muted-foreground hover:text-theme-500 flex flex-1 cursor-pointer items-center gap-1 overflow-hidden text-xs font-medium transition-colors"
      >
        <ImageIcon size={14} />
        <span className="max-w-24 truncate">{data?.src || 'Image'}</span>
        <ArrowUpRight size={14} strokeWidth={2} />
      </a>

      {/*tools*/}
      <div className="text-muted-foreground flex items-center gap-1">
        <div className="bg-border h-3 w-px" />

        <GhostButton
          title="Open Large View"
          onClick={(e) => {
            e.stopPropagation();
            openExpanded(id);
          }}
        >
          <Fullscreen size={14} />
        </GhostButton>

        {/*<GhostButton aria-label="Shrink">*/}
        {/*  <Shrink size={14} />*/}
        {/*</GhostButton>*/}

        {/*<GhostButton aria-label="Adjust">*/}
        {/*  <SlidersHorizontal size={14} />*/}
        {/*</GhostButton>*/}
      </div>
    </div>
  );

  return (
    <NodeWrapper
      id={id}
      data={data}
      type={'image'}
      selected={selected}
      toolbar={ImageToolbar}
      keepAspectRatio={true}
      onDoubleClick={(e) => {
        e.stopPropagation();
        openExpanded(id);
      }}
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
