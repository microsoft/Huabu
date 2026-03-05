import { type Node, type NodeProps } from '@xyflow/react';
import { Fullscreen } from 'lucide-react';

import useCanvasStore from '@/store/canvasStore.ts';

import { NodeWrapper } from './NodeWrapper.tsx';
import { NODE_ICON } from '../../config/nodeIcons.ts';
import { GhostButton } from '../Common/GhostButton.tsx';

import type { CanvasImageNodeData } from './types.ts';

export type ImageNodeType = Node<CanvasImageNodeData, 'image'>;

export const ImageNode = ({ id, data, selected }: NodeProps<ImageNodeType>) => {
  const openExpanded = useCanvasStore((s) => s.openExpanded);

  const ImageToolbar = (
    <div className="flex w-full items-center justify-between gap-2">
      {/* Label */}
      <div className="text-muted-foreground">
        <NODE_ICON.image size={14} />
      </div>
      {/* splitter  */}
      <div className="bg-border h-3 w-px" />
      {/*tools*/}
      <div className="text-muted-foreground flex items-center gap-1">
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
