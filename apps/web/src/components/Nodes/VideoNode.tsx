import { type Node, type NodeProps } from '@xyflow/react';
import { PlayCircle, Volume2, ArrowUpRight } from 'lucide-react';

import { NodeWrapper, type NodeDataProps } from './NodeWrapper.tsx';
import { GhostButton } from '../Common/GhostButton.tsx';

type VideoNodeData = NodeDataProps & {};
export type VideoNodeType = Node<VideoNodeData, 'video'>;

export const VideoNode = ({ id, data, selected }: NodeProps<VideoNodeType>) => {
  const VideoToolbar = (
    <div className="flex w-full items-center justify-between gap-4">
      {/* Source */}
      <a
        href={data?.src}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="nodrag text-muted-foreground hover:text-theme-500 flex flex-1 cursor-pointer items-center gap-1 overflow-hidden text-xs font-medium transition-colors"
      >
        <span className="truncate">Source: {data?.src || 'Unknown Video'}</span>
        <ArrowUpRight size={14} strokeWidth={2} />
      </a>

      {/* Tools */}
      <div className="text-muted-foreground flex items-center gap-2">
        <div className="bg-border h-3 w-px" />
        <GhostButton aria-label="Volume">
          <Volume2 size={14} />
        </GhostButton>
      </div>
    </div>
  );

  return (
    <NodeWrapper
      id={id}
      data={data}
      selected={selected}
      toolbar={VideoToolbar}
      keepAspectRatio={true}
    >
      <div className="bg-foreground/5 flex h-full flex-col justify-center rounded-xl">
        <div className="relative h-full w-full overflow-hidden rounded-xl">
          {data?.src ? (
            <video
              src={data.src}
              controls
              className="nodrag h-full w-full object-contain"
            />
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
