import { type Node, type NodeProps } from '@xyflow/react';
import { clsx } from 'clsx';
import { Download, Fullscreen, ImageOff } from 'lucide-react';
import { memo, useCallback, useState, useRef, useEffect } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';

import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

import { NodeWrapper } from './NodeWrapper.tsx';
import useCanvasStore from '../../store/canvasStore.ts';
import { GhostButton } from '../Common/GhostButton.tsx';

import type { CanvasPdfNodeData } from './types.ts';

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

export type PDFNodeType = Node<CanvasPdfNodeData, 'pdf'>;

/**
 * Estimated height of a single PDF page at scale 0.7 (A4 ≈ 595×842pt).
 * Used to calculate which pages are visible in the scrollable container.
 */
const ESTIMATED_PAGE_HEIGHT = 842 * 0.7; // ~590px
/** Extra pages to render above/below the visible viewport. */
const OVERSCAN = 1;

/**
 * A single PDF page slot. Uses IntersectionObserver to only render the
 * actual <Page> component when it enters the viewport (plus overscan).
 */
const VirtualizedPage = memo(
  ({
    pageNumber,
    containerRef,
  }: {
    pageNumber: number;
    containerRef: React.RefObject<HTMLDivElement | null>;
  }) => {
    const placeholderRef = useRef<HTMLDivElement>(null);
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
      const el = placeholderRef.current;
      const root = containerRef.current;
      if (!el || !root) return;

      const observer = new IntersectionObserver(
        ([entry]) => {
          setIsVisible(entry.isIntersecting);
        },
        {
          root,
          // Render one page above/below the visible area
          rootMargin: `${ESTIMATED_PAGE_HEIGHT * OVERSCAN}px 0px`,
        },
      );

      observer.observe(el);
      return () => observer.disconnect();
    }, [containerRef]);

    return (
      <div
        ref={placeholderRef}
        style={{ minHeight: ESTIMATED_PAGE_HEIGHT }}
        className="flex items-center justify-center"
      >
        {isVisible ? (
          <Page
            pageNumber={pageNumber}
            scale={0.7}
            renderAnnotationLayer={false}
            renderTextLayer={false}
            loading={''}
          />
        ) : null}
      </div>
    );
  },
);

export const PDFNode = memo(
  ({ id, data, selected }: NodeProps<PDFNodeType>) => {
    const openExpanded = useCanvasStore((s) => s.openExpanded);
    const updateNodeData = useCanvasStore((s) => s.updateNodeData);

    const containerRef = useRef<HTMLDivElement>(null);
    const [numPages, setNumPages] = useState<number | null>(null);

    const hasCover = !!data.coverUrl;

    const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
      setNumPages(numPages);
    };

    const handleDownload = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!data.src) return;
        const link = document.createElement('a');
        link.href = data.src;
        link.download =
          data.label || data.src.split('/').pop() || 'document.pdf';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      },
      [data.src, data.label],
    );

    const handleDeleteCover = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        updateNodeData(id, { coverUrl: undefined });
      },
      [id, updateNodeData],
    );

    const PDFToolbar = (
      <div className="flex w-full items-center justify-between gap-3">
        {/* Tools */}
        <div className="text-muted-foreground flex items-center gap-1">
          <GhostButton
            title="Open Large View"
            onClick={(e) => {
              e.stopPropagation();
              openExpanded(id);
            }}
          >
            <Fullscreen size={14} />
          </GhostButton>
          <GhostButton title="Download" onClick={handleDownload}>
            <Download size={14} />
          </GhostButton>
          {hasCover && (
            <GhostButton title="Delete Cover" onClick={handleDeleteCover}>
              <ImageOff size={14} />
            </GhostButton>
          )}
        </div>
      </div>
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
        className={clsx('bg-white transition-all duration-300 ease-in-out')}
        onDoubleClick={(e) => {
          e.stopPropagation();
          openExpanded(id);
        }}
      >
        <div
          ref={containerRef}
          className="bg-border relative flex h-full w-full flex-col overflow-hidden rounded"
        >
          {hasCover ? (
            /* ── Cover image mode ── */
            <img
              src={data.coverUrl}
              alt={data.label || 'PDF cover'}
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            /* ── Default PDF preview mode ── */
            <div
              className={clsx(
                'custom-scrollbar flex h-full w-full flex-col items-center overflow-auto',
                'cursor-grab select-none',
              )}
            >
              {data?.src ? (
                <Document
                  file={data.src}
                  onLoadSuccess={onDocumentLoadSuccess}
                  loading={
                    <div className="text-muted-foreground p-4 text-xs">
                      Loading...
                    </div>
                  }
                  error={
                    <div className="text-danger p-4 text-xs">
                      Error loading PDF.
                    </div>
                  }
                  className="flex flex-col gap-4"
                >
                  {Array.from(new Array(numPages), (_el, index) => (
                    <VirtualizedPage
                      key={`page_${index + 1}`}
                      pageNumber={index + 1}
                      containerRef={containerRef}
                    />
                  ))}
                </Document>
              ) : (
                <div className="text-muted-foreground flex h-full w-full items-center justify-center text-sm">
                  No PDF Source
                </div>
              )}
            </div>
          )}
        </div>
      </NodeWrapper>
    );
  },
);
