// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Download, Fullscreen, ImageOff } from 'lucide-react';
import { lazy, memo, Suspense, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { resolveArtifactUrl } from '@/api/artifact';
import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { useNodePresentation } from '@/hooks/useNodePresentation';
import useCanvasStore from '@/store/canvasStore';
import { openPreviewNode } from '@/store/previewWorkspace/actions';

import { getMissingFileKind, MissingFileBanner } from '../MissingFileBanner';
import { NodeWrapper } from '../NodeWrapper';
import {
  ViewportPreviewCard,
  usePreviewCardSize,
} from '../previewCard/PreviewCard';
import { useDeferredHydration } from '../shared/nodeHydrationScheduler';

import type { CanvasPdfNodeData } from '../types';
import type { Node, NodeProps } from '@xyflow/react';
import type { ReactNode } from 'react';

export type PDFNodeType = Node<CanvasPdfNodeData, 'pdf'>;

/**
 * Lazy-loaded first-page renderer.
 *
 * Splits `react-pdf` + `pdfjs-dist` + `pdfWorker.ts` (which side-effect-
 * imports the ~1 MB worker bundle) out of the initial canvas chunk.
 * Canvases whose PDF nodes already have a cached `coverUrl` never
 * render this component, so pdf.js never loads — first-paint cost for
 * the common "open an existing canvas" path drops by exactly that
 * bundle's parse+compile budget.
 *
 * See {@link ./PDFFirstPageThumbnail.tsx}.
 */
const FirstPageThumbnail = lazy(() => import('./PDFFirstPageThumbnail'));
const EmbeddedPDFPreview = lazy(() =>
  import('./PDFPreview').then(({ PDFPreview }) => ({
    default: PDFPreview,
  })),
);

function ScheduledPDFReader({
  id,
  data,
  interactive,
  zoom,
  fallback,
}: {
  id: string;
  data: CanvasPdfNodeData;
  interactive: boolean;
  zoom: number;
  fallback: ReactNode;
}) {
  const hydrated = useDeferredHydration();
  if (!hydrated) return fallback;
  return (
    <Suspense fallback={fallback}>
      <div
        data-pdf-reading-surface
        className="shrink-0"
        style={{
          // Rasterize at screen width rather than potentially huge authored dimensions.
          transform: `scale(${1 / zoom})`,
          transformOrigin: 'top left',
          width: `${zoom * 100}%`,
          height: `${zoom * 100}%`,
        }}
      >
        <EmbeddedPDFPreview
          id={id}
          data={data}
          embedded
          interactive={interactive}
        />
      </div>
    </Suspense>
  );
}

export const PDFNode = memo(
  ({ id, data, selected, width, height }: NodeProps<PDFNodeType>) => {
    const { t } = useTranslation();
    const cardSize = usePreviewCardSize(id, 'pdf', width, height);
    const { mode, isVisible, isSoleSelected, zoom } = useNodePresentation(
      id,
      'pdf',
      'reading',
    );
    const isReading = mode === 'reading' && isVisible;
    const updateNodeData = useCanvasStore((s) => s.updateNodeData);
    const canvasId = useCanvasStore((s) => s.canvasId);

    const hasCover = !!data.coverUrl;
    const src = typeof data.src === 'string' ? data.src : '';
    const summary =
      typeof (data as { summary?: unknown }).summary === 'string'
        ? ((data as { summary?: string }).summary as string)
        : '';
    const missingFileKind = getMissingFileKind(data);
    const title = data.label || t('node.untitledPdf');

    // Auto-generated thumbnail from the first PDF page (when no manual cover).
    const [thumbnail, setThumbnail] = useState<string | null>(null);
    const [thumbnailError, setThumbnailError] = useState<string | null>(null);

    // Failed captures wait for an explicit retry or a source change.
    useEffect(() => {
      setThumbnail(null);
      setThumbnailError(null);
    }, [src, canvasId]);

    // Whether a fresh first-page capture is required *for this node*. Drives
    // both the shared hydration gate (so N un-covered PDFs don't fire pdf.js
    // worker startup in the same frame) and the lazy module load (no cover ⇒
    // download `react-pdf` chunk; cover already cached ⇒ pdf.js never loads).
    const needsThumbnailCapture =
      !hasCover &&
      !!src &&
      !thumbnail &&
      !thumbnailError &&
      !data.artifactMissing &&
      mode !== 'minimal' &&
      isVisible &&
      !isReading;

    // Gate the heavy pdf.js mount behind the shared per-frame scheduler.
    // `skip` short-circuits the queue entirely when no capture is needed,
    // so a fully-cached canvas yields its hydration slot back to other
    // node types (notes, web previews) instead of holding a no-op grant.
    const thumbnailHydrated = useDeferredHydration(!needsThumbnailCapture);

    const coverImage = hasCover
      ? resolveArtifactUrl(data.coverUrl as string, canvasId)
      : (thumbnail ?? undefined);

    const handleDownload = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!src) return;
        const link = document.createElement('a');
        link.href = resolveArtifactUrl(src, canvasId);
        link.download = data.label || src.split('/').pop() || 'document.pdf';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      },
      [src, data.label, canvasId],
    );

    const handleDeleteCover = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        updateNodeData(id, { coverUrl: undefined });
      },
      [id, updateNodeData],
    );

    const handleThumbnailCapture = useCallback((dataUrl: string) => {
      setThumbnail(dataUrl);
    }, []);

    const handleThumbnailError = useCallback(
      (error: Error) => {
        console.warn('[PDFNode] First-page thumbnail failed', error);
        setThumbnailError(error.message || t('node.previewFailed'));
      },
      [t],
    );

    const handleRetry = useCallback(() => {
      setThumbnailError(null);
    }, []);

    const PDFActions = (
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
          title={t('node.download')}
          onClick={handleDownload}
        >
          <Download />
        </FloatingToolbar.ActionButton>
        {hasCover && (
          <FloatingToolbar.ActionButton
            title={t('node.deleteCover')}
            onClick={handleDeleteCover}
          >
            <ImageOff />
          </FloatingToolbar.ActionButton>
        )}
      </>
    );

    const overview = (
      <ViewportPreviewCard
        {...cardSize}
        accent={data.style?.accent}
        minimal={mode === 'minimal'}
        image={coverImage}
        imageFit={hasCover ? 'cover' : 'contain'}
        imageAlt={data.label || t('node.pdfCover')}
        nodeType="pdf"
        source="PDF"
        title={title}
        summary={summary}
        loading={mode !== 'minimal' && !coverImage && !thumbnailError}
        error={hasCover ? null : thumbnailError}
        onRetry={handleRetry}
      />
    );

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'pdf'}
        selected={selected}
        actions={missingFileKind ? undefined : PDFActions}
        resizable
        keepAspectRatio={false}
        className={missingFileKind ? undefined : 'bg-surface'}
      >
        {missingFileKind ? (
          <MissingFileBanner nodeId={id} />
        ) : (
          <div className="relative flex h-full w-full flex-col">
            {/* Render the first page off-screen to capture a thumbnail when no
                manual cover exists. Gated behind the per-frame hydration
                scheduler *and* React.lazy so:
                  - many un-covered PDFs stream their pdf.js builds one per
                    frame instead of fighting for the main thread, and
                  - canvases whose PDFs all have cached covers never download
                    the `react-pdf` chunk at all. */}
            {needsThumbnailCapture && thumbnailHydrated && (
              <Suspense fallback={null}>
                <FirstPageThumbnail
                  key={`${canvasId}\0${src}`}
                  src={src}
                  canvasId={canvasId}
                  onCapture={handleThumbnailCapture}
                  onError={handleThumbnailError}
                />
              </Suspense>
            )}

            {src ? (
              isReading ? (
                <ScheduledPDFReader
                  key={`${canvasId}\0${src}`}
                  id={id}
                  data={data}
                  interactive={isSoleSelected}
                  zoom={zoom}
                  fallback={overview}
                />
              ) : (
                overview
              )
            ) : (
              <div className="text-fg-subtle flex h-full w-full items-center justify-center text-sm">
                {t('node.noPdfSource')}
              </div>
            )}
          </div>
        )}
      </NodeWrapper>
    );
  },
);
