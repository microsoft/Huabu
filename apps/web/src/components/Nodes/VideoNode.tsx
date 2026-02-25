import { type Node, type NodeProps } from '@xyflow/react';
import { PlayCircle, PlaySquare, Fullscreen, Play } from 'lucide-react';

import useCanvasStore from '@/store/canvasStore.ts';

import { NodeWrapper } from './NodeWrapper.tsx';
import { GhostButton } from '../Common/GhostButton.tsx';

import type { CanvasVideoNodeData } from './types.ts';

export type VideoNodeType = Node<CanvasVideoNodeData, 'video'>;

export const VideoNode = ({ id, data, selected }: NodeProps<VideoNodeType>) => {
  const openExpanded = useCanvasStore((s) => s.openExpanded);

  const VideoToolbar = (
    <div className="flex w-full items-center justify-between gap-2">
      {/* Label */}
      <div className="text-muted-foreground">
        <PlaySquare size={14} />
      </div>
      {/* splitter  */}
      <div className="bg-border h-3 w-px" />

      {/* Tools */}
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

        {/*<GhostButton aria-label="Volume">*/}
        {/*  <Volume2 size={14} />*/}
        {/*</GhostButton>*/}
      </div>
    </div>
  );

  return (
    <NodeWrapper
      id={id}
      data={data}
      type={'video'}
      selected={selected}
      toolbar={VideoToolbar}
      keepAspectRatio={true}
      onDoubleClick={(e) => {
        e.stopPropagation();
        openExpanded(id);
      }}
    >
      <div className="bg-foreground/5 group flex h-full flex-col justify-center rounded border-0">
        <div className="relative h-full w-full overflow-hidden rounded">
          {data?.src ? (
            <>
              <video
                src={data.src}
                className="pointer-events-none h-full w-full object-contain select-none"
                preload="metadata"
                muted
              />
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/10 transition-colors group-hover:bg-black/20">
                <div className="rounded-full bg-black/40 p-3 backdrop-blur-sm transition-transform group-hover:scale-110">
                  <Play className="fill-white text-white" size={24} />
                </div>
              </div>
            </>
          ) : (
            <div className="text-muted-foreground flex h-full w-full flex-col items-center justify-center gap-2 text-sm">
              <PlayCircle size={24} className="opacity-20" />
              <span>No Video Source</span>
            </div>
          )}
        </div>
      </div>
    </NodeWrapper>
  );
};
