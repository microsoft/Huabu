import { type Node, type NodeProps } from '@xyflow/react';
import { clsx } from 'clsx';
import { Download, Fullscreen, ImageOff } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';

import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { useNodeScale } from '@/hooks/useNodeScale';
import { useSourceMeta } from '@/hooks/useSourceMeta';
import useCanvasStore from '@/store/canvasStore';

import { NodeWrapper } from '../NodeWrapper';
import { PreviewCard } from '../PreviewCard';

import type { CanvasPdfNodeData } from '../types';

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

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
    onCapture,
  }: {
    src: string;
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
        <Document file={src} loading={null} error={null}>
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

    const hasCover = !!data.coverUrl;
    const src = typeof data.src === 'string' ? data.src : '';
    const sourceId = typeof data.sourceId === 'string' ? data.sourceId : '';

    // Auto-generated thumbnail from the first PDF page (when no manual cover).
    const [thumbnail, setThumbnail] = useState<string | null>(null);

    const { summary } = useSourceMeta(sourceId || null);

    // Reset thumbnail when src changes so the new PDF gets a fresh capture.
    useEffect(() => {
      setThumbnail(null);
    }, [src]);

    const coverImage = hasCover ? data.coverUrl : (thumbnail ?? undefined);

    const handleDownload = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!src) return;
        const link = document.createElement('a');
        link.href = src;
        link.download = data.label || src.split('/').pop() || 'document.pdf';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      },
      [src, data.label],
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

    const PDFToolbar = (
      <FloatingToolbar.Group>
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
      </FloatingToolbar.Group>
    );

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'pdf'}
        selected={selected}
        toolbar={PDFToolbar}
        resizable
        keepAspectRatio={false}
        className={clsx('bg-surface transition-all duration-300 ease-in-out')}
      >
        <div className="relative flex h-full w-full flex-col overflow-hidden rounded">
          {/* Render the first page off-screen to capture a thumbnail when no manual cover exists */}
          {!hasCover && src && !thumbnail && (
            <FirstPageThumbnail src={src} onCapture={handleThumbnailCapture} />
          )}

          <div
            style={{
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
              width: `${100 / scale}%`,
              height: `${100 / scale}%`,
            }}
          >
            {src ? (
              <PreviewCard
                image={coverImage}
                imageAlt={data.label || 'PDF cover'}
                nodeType="pdf"
                title={data.label || 'Untitled PDF'}
                loading={!coverImage}
                imagePosition="top"
                accentColor={data.style?.accent}
                onInfoClick={() => openExpanded(id)}
              >
                {summary ? (
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <p className="text-fg-muted text-base leading-relaxed">
                      {summary}
                    </p>
                  </div>
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
