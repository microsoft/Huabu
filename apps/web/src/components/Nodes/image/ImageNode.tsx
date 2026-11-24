// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Download, Maximize2, Image as ImageIcon } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { resolveArtifactUrl } from '@/api/artifact';
import { DropdownMenuItem } from '@/components/Common/DropdownMenu';
import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import useCanvasStore from '@/store/canvasStore.ts';
import { openPreviewNode } from '@/store/previewWorkspace/actions';
import {
  canDownloadMediaSource,
  triggerMediaDownload,
} from '@/utils/io/nodeDownload';

import { getMissingFileKind, MissingFileBanner } from '../MissingFileBanner';
import { NodeWrapper } from '../NodeWrapper';

import type { CanvasImageNodeData } from '../types';
import type { Node, NodeProps } from '@xyflow/react';

export type ImageNodeType = Node<CanvasImageNodeData, 'image'>;

export const ImageNode = memo(
  ({ id, data, selected }: NodeProps<ImageNodeType>) => {
    const { t } = useTranslation();
    const canvasId = useCanvasStore((s) => s.canvasId);

    // Track whether the underlying `<img>` element has finished loading
    // (or failed). While the bytes are still in flight we show a
    // centered, gently pulsing image icon — semantically signals
    // "image goes here" without competing with the surrounding canvas.
    const src = data?.src;
    const missingFileKind = getMissingFileKind(data);
    const [imgLoaded, setImgLoaded] = useState(false);
    useEffect(() => {
      // Reset loading state whenever the source changes so the
      // placeholder re-appears for the new image.
      setImgLoaded(false);
    }, [src]);

    const ImageActions = (
      <FloatingToolbar.ActionButton
        title={t('node.openLargeView')}
        onClick={(e) => {
          e.stopPropagation();
          openPreviewNode(id);
        }}
      >
        <Maximize2 />
      </FloatingToolbar.ActionButton>
    );

    const canDownload = canDownloadMediaSource(src, Boolean(missingFileKind));
    const handleDownload = useCallback(() => {
      triggerMediaDownload({
        src,
        canvasId,
        label: data?.label,
        defaultExt: '.png',
        fallbackStem: 'image',
        missing: Boolean(missingFileKind),
      });
    }, [src, canvasId, data?.label, missingFileKind]);

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'image'}
        selected={selected}
        actions={missingFileKind ? undefined : ImageActions}
        overflow={
          canDownload ? (
            <DropdownMenuItem icon={<Download />} onClick={handleDownload}>
              {t('node.download')}
            </DropdownMenuItem>
          ) : undefined
        }
        keepAspectRatio={true}
      >
        {missingFileKind ? (
          <MissingFileBanner nodeId={id} />
        ) : (
          <div className="flex h-full flex-col rounded-[inherit]">
            <div className="relative h-full w-full overflow-hidden rounded-[inherit]">
              {src ? (
                <>
                  <img
                    src={resolveArtifactUrl(src, canvasId)}
                    alt={data?.label || t('node.nodeImage')}
                    className="pointer-events-none h-full w-full rounded-[inherit] border-0 object-contain"
                    onLoad={() => setImgLoaded(true)}
                    onError={() => setImgLoaded(true)}
                    style={imgLoaded ? undefined : { visibility: 'hidden' }}
                  />
                  {!imgLoaded && (
                    <div
                      className="bg-surface pointer-events-none absolute inset-0 flex items-center justify-center rounded-[inherit]"
                      // `container-type: size` exposes the node's dimensions
                      // to CSS `cqmin` units below so the icon scales with
                      // the smaller of width/height instead of staying a
                      // fixed size regardless of node size.
                      style={{ containerType: 'size' }}
                      aria-hidden
                    >
                      <ImageIcon
                        className="text-fg-subtle animate-pulse"
                        // 70% of the node's shorter side, clamped between
                        // 48px (tiny thumbnails) and 200px (huge nodes).
                        style={{
                          width: 'clamp(48px, 70cqmin, 200px)',
                          height: 'clamp(48px, 70cqmin, 200px)',
                        }}
                        strokeWidth={1.5}
                      />
                    </div>
                  )}
                </>
              ) : (
                <div className="text-fg-subtle flex h-full w-full items-center justify-center text-sm">
                  {t('node.noImageSource')}
                </div>
              )}
            </div>
          </div>
        )}
      </NodeWrapper>
    );
  },
);
