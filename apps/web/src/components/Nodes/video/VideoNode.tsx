import { type Node, type NodeProps } from '@xyflow/react';
import { PlayCircle, Fullscreen, Play } from 'lucide-react';
import { memo } from 'react';

import { resolveArtifactUrl } from '@/api/artifact';
import useCanvasStore from '@/store/canvasStore.ts';

import { FloatingToolbar } from '../../Common/FloatingToolbar.tsx';
import { NodeWrapper } from '../NodeWrapper.tsx';

import type { CanvasVideoNodeData } from '../types.ts';

export type VideoNodeType = Node<CanvasVideoNodeData, 'video'>;

export const VideoNode = memo(
  ({ id, data, selected }: NodeProps<VideoNodeType>) => {
    const openExpanded = useCanvasStore((s) => s.openExpanded);

    const VideoToolbar = (
      <FloatingToolbar.ActionButton
        title="Open Large View"
        onClick={(e) => {
          e.stopPropagation();
          openExpanded(id);
        }}
      >
        <Fullscreen />
      </FloatingToolbar.ActionButton>
    );

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'video'}
        selected={selected}
        toolbar={VideoToolbar}
        keepAspectRatio={true}
      >
        <div className="bg-fg-default/5 group flex h-full flex-col justify-center rounded border-0">
          <div className="relative h-full w-full overflow-hidden rounded">
            {data?.src ? (
              <>
                <video
                  src={resolveArtifactUrl(data.src)}
                  className="pointer-events-none h-full w-full object-contain select-none"
                  preload="metadata"
                  muted
                />
                <div className="bg-inverse/10 group-hover:bg-inverse/20 pointer-events-none absolute inset-0 flex items-center justify-center transition-colors">
                  <div className="bg-inverse/40 rounded-full p-3 backdrop-blur-sm transition-transform group-hover:scale-110">
                    <Play
                      className="fill-fg-inverse text-fg-inverse"
                      size={24}
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="text-fg-subtle flex h-full w-full flex-col items-center justify-center gap-2 text-sm">
                <PlayCircle size={24} className="opacity-20" />
                <span>No Video Source</span>
              </div>
            )}
          </div>
        </div>
      </NodeWrapper>
    );
  },
);
