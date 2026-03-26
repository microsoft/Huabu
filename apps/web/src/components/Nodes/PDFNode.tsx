import { type Node, type NodeProps } from '@xyflow/react';
import { clsx } from 'clsx';
import { Download, Fullscreen, ImageOff, Loader2 } from 'lucide-react';
import {
  memo,
  useCallback,
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
} from 'react';
import { Document, Page, pdfjs } from 'react-pdf';

import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

import { NodeWrapper } from './NodeWrapper.tsx';
import { PreviewCard } from './PreviewCard.tsx';
import { useNodeScale } from '../../hooks/useNodeScale.ts';
import useCanvasStore from '../../store/canvasStore.ts';
import { IconButton } from '../Common/IconButton.tsx';

import type { CanvasPdfNodeData } from './types.ts';

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

export type PDFNodeType = Node<CanvasPdfNodeData, 'pdf'>;

/** A4 aspect ratio (height / width ≈ 1.414). Used for the fallback placeholder. */
const A4_ASPECT = 842 / 595;
/** Extra pages to render above/below the visible viewport. */
const OVERSCAN = 2;
/**
 * When CSS scale-up exceeds this ratio the canvas is re-rendered at the
 * current container width so the PDF stays crisp.  CSS transform bridges
 * the visual gap until the new canvas is ready → no flash.
 */
const UPSCALE_THRESHOLD = 1.15;
/** Debounce delay (ms) before committing a high-res re-render. */
const RERENDER_DEBOUNCE_MS = 400;

/**
 * A single PDF page slot. Uses IntersectionObserver to lazily render the
 * actual <Page> component when it enters the viewport (plus overscan).
 *
 * Once a page has been rendered, it stays mounted (hidden via
 * `visibility: hidden`) so that re-scrolling back doesn't re-mount the
 * component and cause a flash of blank content.
 *
 * After the first render the real page height is measured via
 * `onRenderSuccess` so the placeholder matches the actual content and
 * eliminates scroll-jumping for non-A4 pages.
 */
const VirtualizedPage = memo(
  ({
    pageNumber,
    containerRef,
    renderedWidth,
  }: {
    pageNumber: number;
    containerRef: React.RefObject<HTMLDivElement | null>;
    renderedWidth: number;
  }) => {
    const placeholderRef = useRef<HTMLDivElement>(null);
    const [isVisible, setIsVisible] = useState(false);
    // Once true the <Page> stays mounted forever (hidden when off-screen).
    const [hasRendered, setHasRendered] = useState(false);
    const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);

    const fallbackPageHeight = renderedWidth * A4_ASPECT;

    useEffect(() => {
      const el = placeholderRef.current;
      const root = containerRef.current;
      if (!el || !root) return;

      const margin = fallbackPageHeight * OVERSCAN;

      const observer = new IntersectionObserver(
        ([entry]) => {
          const visible = entry.isIntersecting;
          setIsVisible(visible);
          if (visible) setHasRendered(true);
        },
        {
          root,
          rootMargin: `${margin}px 0px`,
        },
      );

      observer.observe(el);
      return () => observer.disconnect();
    }, [containerRef, fallbackPageHeight]);

    const handleRenderSuccess = useCallback(() => {
      // Measure the actual rendered canvas height to replace the fallback.
      const canvas = placeholderRef.current?.querySelector('canvas');
      if (canvas) {
        setMeasuredHeight(canvas.offsetHeight);
      }
    }, []);

    const pageHeight = measuredHeight ?? fallbackPageHeight;

    return (
      <div
        ref={placeholderRef}
        style={{ minHeight: pageHeight }}
        className="flex items-center justify-center"
      >
        {hasRendered ? (
          <div style={isVisible ? undefined : { visibility: 'hidden' }}>
            <Page
              pageNumber={pageNumber}
              width={renderedWidth}
              renderAnnotationLayer={false}
              renderTextLayer={false}
              loading={
                <div
                  className="bg-surface-subtle flex items-center justify-center"
                  style={{ height: fallbackPageHeight }}
                >
                  <Loader2
                    size={18}
                    className="text-muted-foreground animate-spin"
                  />
                </div>
              }
              onRenderSuccess={handleRenderSuccess}
            />
          </div>
        ) : null}
      </div>
    );
  },
);

export const PDFNode = memo(
  ({ id, data, selected }: NodeProps<PDFNodeType>) => {
    const scale = useNodeScale(id, 'pdf');
    const openExpanded = useCanvasStore((s) => s.openExpanded);
    const updateNodeData = useCanvasStore((s) => s.updateNodeData);

    const containerRef = useRef<HTMLDivElement>(null);
    const [numPages, setNumPages] = useState<number | null>(null);
    const [containerWidth, setContainerWidth] = useState(0);
    // The width at which the PDF canvas is actually rendered. Only updates on
    // first measure and when the container grows past UPSCALE_THRESHOLD.
    const [renderedWidth, setRenderedWidth] = useState(0);
    const rerenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Track the container's live width for CSS transform scaling.
    useLayoutEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const ro = new ResizeObserver(([entry]) => {
        const available = entry.contentRect.width;
        if (available > 0) setContainerWidth(available);
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, []);

    // Debounced re-render: when the container is significantly larger than the
    // rendered canvas, schedule a high-res re-render. CSS scale covers the gap.
    useEffect(() => {
      // First measurement → render immediately.
      if (renderedWidth === 0 && containerWidth > 0) {
        setRenderedWidth(containerWidth);
        return;
      }
      if (containerWidth <= 0 || renderedWidth <= 0) return;

      const ratio = containerWidth / renderedWidth;
      if (ratio > UPSCALE_THRESHOLD) {
        if (rerenderTimerRef.current) clearTimeout(rerenderTimerRef.current);
        rerenderTimerRef.current = setTimeout(() => {
          setRenderedWidth(containerWidth);
          rerenderTimerRef.current = null;
        }, RERENDER_DEBOUNCE_MS);
      }

      return () => {
        if (rerenderTimerRef.current) {
          clearTimeout(rerenderTimerRef.current);
          rerenderTimerRef.current = null;
        }
      };
    }, [containerWidth, renderedWidth]);

    // Instant visual scaling via CSS transform while real render is debounced.
    const scaleFactor =
      renderedWidth > 0 && containerWidth > 0
        ? containerWidth / renderedWidth
        : 1;

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
          <IconButton
            title="Open Large View"
            onClick={(e) => {
              e.stopPropagation();
              openExpanded(id);
            }}
          >
            <Fullscreen size={14} />
          </IconButton>
          <IconButton title="Download" onClick={handleDownload}>
            <Download size={14} />
          </IconButton>
          {hasCover && (
            <IconButton title="Delete Cover" onClick={handleDeleteCover}>
              <ImageOff size={14} />
            </IconButton>
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
        className={clsx('bg-card transition-all duration-300 ease-in-out')}
      >
        <div
          ref={containerRef}
          className="relative flex h-full w-full flex-col overflow-hidden rounded"
        >
          {hasCover ? (
            /* ── Cover card mode ── */
            <div
              style={{
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
                width: `${100 / scale}%`,
                height: `${100 / scale}%`,
              }}
            >
              <PreviewCard
                image={data.coverUrl}
                imageAlt={data.label || 'PDF cover'}
                nodeType="pdf"
                title={data.label || 'Untitled PDF'}
              />
            </div>
          ) : (
            /* ── Default PDF preview mode ── */
            <div
              className={clsx(
                'custom-scrollbar flex h-full w-full flex-col overflow-x-hidden overflow-y-auto',
                'cursor-grab select-none',
              )}
            >
              {data?.src ? (
                <div
                  style={{
                    transformOrigin: 'top left',
                    transform: `scale(${scaleFactor})`,
                    width: renderedWidth > 0 ? renderedWidth : undefined,
                  }}
                >
                  <Document
                    file={data.src}
                    onLoadSuccess={onDocumentLoadSuccess}
                    loading={
                      <div className="text-muted-foreground flex h-full min-h-40 w-full items-center justify-center gap-2 p-4 text-xs">
                        <Loader2 size={16} className="animate-spin" />
                      </div>
                    }
                    error={
                      <div className="text-danger p-4 text-xs">
                        Error loading PDF.
                      </div>
                    }
                    className="flex flex-col gap-0"
                  >
                    {renderedWidth > 0 &&
                      Array.from(new Array(numPages), (_el, index) => (
                        <VirtualizedPage
                          key={`page_${index + 1}`}
                          pageNumber={index + 1}
                          containerRef={containerRef}
                          renderedWidth={renderedWidth}
                        />
                      ))}
                  </Document>
                </div>
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
