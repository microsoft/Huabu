import { Fullscreen } from 'lucide-react';
import { memo, useEffect, useState } from 'react';

import { resolveArtifactUrl } from '@/api/artifact';
import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { SkeletonLines } from '@/components/Common/SkeletonLines';
import useCanvasStore from '@/store/canvasStore.ts';

import { MissingFileBanner } from '../MissingFileBanner';
import { NodeWrapper } from '../NodeWrapper';

import type { CanvasImageNodeData } from '../types';
import type { Node, NodeProps } from '@xyflow/react';

export type ImageNodeType = Node<CanvasImageNodeData, 'image'>;

export const ImageNode = memo(
  ({ id, data, selected }: NodeProps<ImageNodeType>) => {
    const openExpanded = useCanvasStore((s) => s.openExpanded);
    const canvasId = useCanvasStore((s) => s.canvasId);

    // Track whether the underlying `<img>` element has finished loading
    // (or failed). While the bytes are still in flight we render a
    // `SkeletonLines` shimmer overlay — same pattern other nodes (PDF,
    // Note, PreviewCard) use for their loading state.
    const src = data?.src;
    const [imgLoaded, setImgLoaded] = useState(false);
    useEffect(() => {
      // Reset loading state whenever the source changes so the skeleton
      // re-appears for the new image.
      setImgLoaded(false);
    }, [src]);

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
            ) : src ? (
              <>
                <img
                  src={resolveArtifactUrl(src, canvasId)}
                  alt={data?.label || 'Node image'}
                  className="pointer-events-none h-full w-full rounded-lg border-0 object-contain"
                  onLoad={() => setImgLoaded(true)}
                  onError={() => setImgLoaded(true)}
                  style={imgLoaded ? undefined : { visibility: 'hidden' }}
                />
                {!imgLoaded && (
                  <div
                    className="pointer-events-none absolute inset-0 flex items-center justify-center"
                    aria-hidden
                  >
                    <SkeletonLines className="w-full max-w-xs" />
                  </div>
                )}
              </>
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
