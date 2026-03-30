import { type Node, type NodeProps } from '@xyflow/react';
import { Fullscreen } from 'lucide-react';
import { memo } from 'react';

import { Button } from '@/components/Common/Button';
import useCanvasStore from '@/store/canvasStore.ts';

import { NodeWrapper } from '../NodeWrapper';

import type { CanvasImageNodeData } from '../types';

export type ImageNodeType = Node<CanvasImageNodeData, 'image'>;

export const ImageNode = memo(
  ({ id, data, selected }: NodeProps<ImageNodeType>) => {
    const openExpanded = useCanvasStore((s) => s.openExpanded);

    const ImageToolbar = (
      <div className="flex w-full items-center justify-between gap-2">
        {/*tools*/}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            iconOnly
            size="sm"
            title="Open Large View"
            onClick={(e) => {
              e.stopPropagation();
              openExpanded(id);
            }}
          >
            <Fullscreen />
          </Button>
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
              <div className="text-fg-subtle flex h-full w-full items-center justify-center text-sm">
                No Image Source
              </div>
            )}
          </div>
        </div>
      </NodeWrapper>
    );
  },
);
