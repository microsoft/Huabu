import { Fullscreen } from 'lucide-react';
import { memo } from 'react';

import { resolveArtifactUrl } from '@/api/artifact';
import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import useCanvasStore from '@/store/canvasStore.ts';

import { MissingFileBanner } from '../MissingFileBanner';
import { NodeWrapper } from '../NodeWrapper';

import type { CanvasImageNodeData } from '../types';
import type { Node, NodeProps } from '@xyflow/react';

export type ImageNodeType = Node<CanvasImageNodeData, 'image'>;

export const ImageNode = memo(
  ({ id, data, selected }: NodeProps<ImageNodeType>) => {
    const openExpanded = useCanvasStore((s) => s.openExpanded);

    const ImageActions = (
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
        type={'image'}
        selected={selected}
        actions={ImageActions}
        keepAspectRatio={true}
      >
        <div className="flex h-full flex-col">
          <div className="relative h-full w-full overflow-hidden">
            {data?.artifactMissing ? (
              <MissingFileBanner
                nodeId={id}
                title="Image file missing"
                description="The artifact for this node was deleted or renamed outside the app."
              />
            ) : data?.src ? (
              <img
                src={resolveArtifactUrl(data.src)}
                alt={data.label || 'Node image'}
                className="pointer-events-none h-full w-full rounded-lg border-0 object-contain"
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
