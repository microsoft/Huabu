import { clsx } from 'clsx';
import { Download, Fullscreen, ImageOff } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Document, Page } from 'react-pdf';

import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

import { MissingFileBanner } from '../MissingFileBanner';
import { NodeWrapper } from '../NodeWrapper';
import { PreviewCard } from '../PreviewCard';
import { PDF_DOCUMENT_OPTIONS } from './pdfWorker';

import type { CanvasPdfNodeData } from '../types';
import type { Node, NodeProps } from '@xyflow/react';

import { resolveArtifactUrl } from '@/api/artifact';
import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { useNodeScale } from '@/hooks/useNodeScale';
import useCanvasStore from '@/store/canvasStore';

export type PDFNodeType = Node<CanvasPdfNodeData, 'pdf'>;

/** Width used to render the first-page thumbnail canvas. */
const THUMBNAIL_WIDTH = 400;

/**
 * Renders the first page of a PDF into a hidden canvas and converts it to a
 * data-URL that can be used as the cover image in a PreviewCard.
 */
const FirstPageThumbnail = memo(
  ({
    src,
    canvasId,
    onCapture,
  }: {
    src: string;
    canvasId: string;
    onCapture: (dataUrl: string) => void;
  }) => {
    const captured = useRef(false);
    const containerRef = useRef<HTMLDivElement>(null);

    const handleRenderSuccess = useCallback(
      (_page: { width: number }) => {
        if (captured.current) return;
        const canvas = containerRef.current?.querySelector('canvas');
        if (canvas) {
          captured.current = true;
          onCapture(canvas.toDataURL('image/jpeg', 0.85));
        }
      },
      [onCapture],
    );

    return (
      <div
        ref={containerRef}
        style={{ position: 'absolute', left: -9999, top: -9999 }}
        aria-hidden
      >
        <Document
          file={resolveArtifactUrl(src, canvasId)}
          options={PDF_DOCUMENT_OPTIONS}
          loading={null}
          error={null}
        >
          <Page
            pageNumber={1}
            width={THUMBNAIL_WIDTH}
            renderAnnotationLayer={false}
            renderTextLayer={false}
            onRenderSuccess={handleRenderSuccess}
          />
        </Document>
      </div>
    );
  },
);

export const PDFNode = memo(
  ({ id, data, selected }: NodeProps<PDFNodeType>) => {
    const scale = useNodeScale(id, 'pdf');
    const openExpanded = useCanvasStore((s) => s.openExpanded);
    const updateNodeData = useCanvasStore((s) => s.updateNodeData);
    const canvasId = useCanvasStore((s) => s.canvasId);

    const hasCover = !!data.coverUrl;
    const src = typeof data.src === 'string' ? data.src : '';
    const summary =
      typeof (data as { summary?: unknown }).summary === 'string'
        ? ((data as { summary?: string }).summary as string)
        : '';

    // Auto-generated thumbnail from the first PDF page (when no manual cover).
    const [thumbnail, setThumbnail] = useState<string | null>(null);

    // Reset thumbnail when src changes so the new PDF gets a fresh capture.
    useEffect(() => {
      setThumbnail(null);
    }, [src]);

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

    const PDFActions = (
      <>
        <FloatingToolbar.ActionButton
          title="Open Large View"
          onClick={(e) => {
            e.stopPropagation();
            openExpanded(id);
          }}
        >
          <Fullscreen />
        </FloatingToolbar.ActionButton>
        <FloatingToolbar.ActionButton title="Download" onClick={handleDownload}>
          <Download />
        </FloatingToolbar.ActionButton>
        {hasCover && (
          <FloatingToolbar.ActionButton
            title="Delete Cover"
            onClick={handleDeleteCover}
          >
            <ImageOff />
          </FloatingToolbar.ActionButton>
        )}
      </>
    );

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'pdf'}
        selected={selected}
        actions={PDFActions}
        resizable
        keepAspectRatio={false}
        className={clsx('bg-surface transition-all duration-300 ease-in-out')}
      >
        <div className="relative flex h-full w-full flex-col overflow-hidden rounded-lg">
          {/* Render the first page off-screen to capture a thumbnail when no manual cover exists */}
          {!hasCover && src && !thumbnail && !data.artifactMissing && (
            <FirstPageThumbnail
              src={src}
              canvasId={canvasId}
              onCapture={handleThumbnailCapture}
            />
          )}

          <div
            style={{
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
              width: `${100 / scale}%`,
              height: `${100 / scale}%`,
            }}
          >
            {data.artifactMissing ? (
              <MissingFileBanner
                nodeId={id}
                title="PDF file missing"
                description="The artifact for this node was deleted or renamed outside the app."
              />
            ) : src ? (
              <PreviewCard
                image={coverImage}
                imageAlt={data.label || 'PDF cover'}
                nodeType="pdf"
                title={data.label || 'Untitled PDF'}
                loading={!coverImage}
                imagePosition="top"
                accentColor={data.style?.accent}
              >
                {summary ? (
                  <p className="text-fg-muted line-clamp-5 text-base leading-relaxed">
                    {summary}
                  </p>
                ) : null}
              </PreviewCard>
            ) : (
              <div className="text-fg-subtle flex h-full w-full items-center justify-center text-sm">
                No PDF Source
              </div>
            )}
          </div>
        </div>
      </NodeWrapper>
    );
  },
);
