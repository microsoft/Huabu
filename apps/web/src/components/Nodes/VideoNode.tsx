import { type Node, type NodeProps } from '@xyflow/react';
import {
  PlayCircle,
  ArrowUpRight,
  PlaySquare,
  Fullscreen,
  Play,
} from 'lucide-react';

import useCanvasStore from '@/store/canvasStore.ts';

import { NodeWrapper, type NodeDataProps } from './NodeWrapper.tsx';
import { GhostButton } from '../Common/GhostButton.tsx';

type VideoNodeData = NodeDataProps & {};
export type VideoNodeType = Node<VideoNodeData, 'video'>;

export const VideoNode = ({ id, data, selected }: NodeProps<VideoNodeType>) => {
  const openExpanded = useCanvasStore((s) => s.openExpanded);

  const VideoToolbar = (
    <div className="flex w-full items-center justify-between gap-2">
      {/* Source */}
      <a
        href={data?.src}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="nodrag text-muted-foreground hover:text-theme-500 flex flex-1 cursor-pointer items-center gap-1 overflow-hidden text-xs font-medium transition-colors"
      >
        <PlaySquare size={14} />
        <span className="max-w-24 truncate">{data?.src || 'Video'}</span>
        <ArrowUpRight size={14} strokeWidth={2} />
      </a>

      {/* Tools */}
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
