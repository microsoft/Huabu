// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Copy, Download, Fullscreen, Image as ImageIcon } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { resolveArtifactUrl } from '@/api/artifact';
import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { toast } from '@/components/Common/Toast';
import useCanvasStore from '@/store/canvasStore.ts';
import { openPreviewNode } from '@/store/previewWorkspace/actions';
import { copyImageToClipboard } from '@/utils/io/clipboard';

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

    const downloadImage = useCallback(() => {
      if (!src) return;
      const link = document.createElement('a');
      link.href = resolveArtifactUrl(src, canvasId);
      link.download = data.label || src.split('/').pop() || 'image';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }, [canvasId, data.label, src]);

    const handleCopyImage = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!src) return;
        void copyImageToClipboard(resolveArtifactUrl(src, canvasId))
          .then(() => {
            toast(t('node.imageCopied'), { tone: 'success' });
          })
          .catch((error: unknown) => {
            console.error('[clipboard] explicit image copy failed', error);
            toast(t('node.copyImageFailed'), {
              tone: 'danger',
              action: {
                label: t('node.downloadImage'),
                onClick: downloadImage,
              },
            });
          });
      },
      [canvasId, downloadImage, src, t],
    );

    const ImageActions = (
      <>
        <FloatingToolbar.ActionButton
          title={t('node.openLargeView')}
          onClick={(e) => {
            e.stopPropagation();
            openPreviewNode(id);
          }}
        >
          <Fullscreen />
        </FloatingToolbar.ActionButton>
        <FloatingToolbar.ActionButton
          title={t('node.copyImage')}
          onClick={handleCopyImage}
          disabled={!src}
        >
          <Copy />
        </FloatingToolbar.ActionButton>
        <FloatingToolbar.ActionButton
          title={t('node.downloadImage')}
          disabled={!src}
          onClick={(e) => {
            e.stopPropagation();
            downloadImage();
          }}
        >
          <Download />
        </FloatingToolbar.ActionButton>
      </>
    );

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'image'}
        selected={selected}
        actions={missingFileKind ? undefined : ImageActions}
        keepAspectRatio={true}
      >
        {missingFileKind ? (
          <MissingFileBanner nodeId={id} />
        ) : (
          <div className="flex h-full flex-col">
            <div className="relative h-full w-full overflow-hidden">
              {src ? (
                <>
                  <img
                    src={resolveArtifactUrl(src, canvasId)}
                    alt={data?.label || t('node.nodeImage')}
                    className="pointer-events-none h-full w-full rounded-lg border-0 object-contain"
                    onLoad={() => setImgLoaded(true)}
                    onError={() => setImgLoaded(true)}
                    style={imgLoaded ? undefined : { visibility: 'hidden' }}
                  />
                  {!imgLoaded && (
                    <div
                      className="bg-surface pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg"
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
