import clsx from 'clsx';
import { Loader2, Scan } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Document } from 'react-pdf';

import { uploadImage } from '@/api/artifact';
import { useChatStore } from '@/store/chatStore';

import { FloatingDragHandle } from './FloatingDragHandle';
import { PDFPageWithOverlay } from './PDFPageWithOverlay';
import { IconButton } from '../Common/IconButton';

import type { PreviewComponentProps } from './NotePreview';
import type { AreaCapturedEvent, NormalizedRect } from './PDFPageWithOverlay';
import type { ChatAttachment } from '@sediment/shared';

/**
 * When CSS scale-up exceeds this ratio the canvas is re-rendered at the
 * current container width so the PDF stays crisp.  CSS transform bridges
 * the visual gap until the new canvas is ready → no flash.
 */
const UPSCALE_THRESHOLD = 1.15;
/** Debounce delay (ms) before committing a high-res re-render. */
const RERENDER_DEBOUNCE_MS = 400;

type PendingCaptureDrag = {
  /** Text extracted from the captured region (empty string = none found) */
  text: string;
  imageUrl: string | null;
  capturing: boolean;
  position: { x: number; y: number };
  /** Which page the selection was drawn on (0-based) */
  pageIndex: number;
  /** The selection rectangle (normalized 0–1) to persist on the page */
  captureRect: NormalizedRect;
};

export const PDFPreview = ({ data, onDataChange }: PreviewComponentProps) => {
  const src = typeof data.src === 'string' ? data.src : '';
  const sourceId =
    typeof data.sourceId === 'string' ? data.sourceId : undefined;
  const addPendingAttachment = useChatStore((s) => s.addPendingAttachment);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [docLoaded, setDocLoaded] = useState(false);
  // Reset loading state when the PDF source changes.
  useEffect(() => {
    setDocLoaded(false);
  }, [src]);
  const [captureMode, setCaptureMode] = useState(false);
  const [pendingCapture, setPendingCapture] =
    useState<PendingCaptureDrag | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  // The width at which the PDF canvas is actually rendered.  Starts at 0 and
  // is updated when the container is first measured *and* whenever the
  // container grows significantly (debounced) so the canvas stays sharp.
  const [renderedWidth, setRenderedWidth] = useState<number>(0);
  const rerenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const available = entry.contentRect.width;
      if (available > 0) {
        setContainerWidth(available);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Debounced re-render: when the container is significantly larger than the
  // rendered canvas, schedule a state update so react-pdf re-renders at full
  // resolution.  CSS scale bridges the visual gap during the debounce window.
  useEffect(() => {
    // First measurement — render immediately without debounce.
    if (renderedWidth === 0 && containerWidth > 0) {
      setRenderedWidth(containerWidth);
      return;
    }

    if (containerWidth <= 0 || renderedWidth <= 0) return;

    const ratio = containerWidth / renderedWidth;
    if (ratio > UPSCALE_THRESHOLD) {
      // Clear any pending timer and schedule a new one
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

  // Dismiss the floating drag handle on scroll
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || !pendingCapture) return;
    const handleScroll = () => setPendingCapture(null);
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [pendingCapture]);

  // CSS transform scales the already-rendered canvas in real-time.
  // Once the debounced re-render fires, scaleFactor returns to ~1 and the
  // canvas is at native resolution again → no visual jump.
  const scaleFactor =
    renderedWidth > 0 && containerWidth > 0
      ? containerWidth / renderedWidth
      : 1;

  const onDocumentLoadSuccess = useCallback(
    ({ numPages: n }: { numPages: number }) => {
      setNumPages(n);
      setDocLoaded(true);
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Area-capture handler
  // ---------------------------------------------------------------------------
  const handleAreaCaptured = useCallback(
    ({
      position,
      getBlob,
      getText,
      pageIndex,
      captureRect,
    }: AreaCapturedEvent) => {
      const doCapture = async () => {
        setPendingCapture({
          text: '',
          imageUrl: null,
          capturing: true,
          position,
          pageIndex,
          captureRect,
        });

        // Run text extraction and image upload in parallel
        try {
          const [blob, extractedText] = await Promise.all([
            getBlob(),
            getText(),
          ]);

          if (!blob) throw new Error('Canvas capture returned null');

          const file = new File([blob], 'pdf-capture.png', {
            type: 'image/png',
          });
          const url = await uploadImage(file);

          setPendingCapture((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              text: extractedText,
              imageUrl: url,
              capturing: false,
            };
          });
        } catch {
          setPendingCapture((prev) => {
            if (!prev) return prev;
            return { ...prev, capturing: false };
          });
        }
      };

      void doCapture();
    },
    [setPendingCapture],
  );

  // ---------------------------------------------------------------------------
  // Send captured area to chat as a pending attachment
  // ---------------------------------------------------------------------------
  const handleSendToChat = useCallback(
    (attachment: ChatAttachment) => {
      addPendingAttachment(attachment);
    },
    [addPendingAttachment],
  );

  // ---------------------------------------------------------------------------
  // Set captured area as the PDF node cover image
  // ---------------------------------------------------------------------------
  const handleSetCover = useCallback(
    (imageUrl: string) => {
      onDataChange?.({ coverUrl: imageUrl });
    },
    [onDataChange],
  );

  return (
    <div className="relative flex h-full flex-col">
      {/* Loading overlay — visible until document metadata is parsed */}
      {src && !docLoaded && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-white">
          <Loader2 size={18} className="text-muted-foreground animate-spin" />
        </div>
      )}
      {/* ── PDF pages ── */}
      <div
        ref={scrollContainerRef}
        className="custom-scrollbar flex-1 overflow-x-hidden overflow-y-auto bg-white p-1"
      >
        {src ? (
          <div
            style={{
              transformOrigin: 'top left',
              transform: `scale(${scaleFactor})`,
              width: renderedWidth > 0 ? renderedWidth : undefined,
            }}
          >
            <Document
              file={src}
              onLoadSuccess={onDocumentLoadSuccess}
              loading=""
              error={
                <div className="p-4 text-xs text-red-300">
                  Error loading PDF
                </div>
              }
              className={clsx('flex flex-col items-center gap-0')}
            >
              {Array.from(new Array(numPages ?? 0), (_el, index) => (
                <PDFPageWithOverlay
                  key={`page_${index + 1}`}
                  pageNumber={index + 1}
                  pageIndex={index}
                  pageWidth={renderedWidth > 0 ? renderedWidth : undefined}
                  captureEnabled={captureMode}
                  onAreaCaptured={handleAreaCaptured}
                  persistedRect={
                    pendingCapture && pendingCapture.pageIndex === index
                      ? pendingCapture.captureRect
                      : undefined
                  }
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

      {/* ── Floating toolbar (top-left, vertical) ── */}
      <div className="pointer-events-none absolute top-3 left-3 z-10">
        <div className="text-muted-foreground border-border pointer-events-auto flex flex-col items-center gap-2 rounded-sm border bg-white p-0">
          <IconButton
            title="Select Area"
            className={clsx(captureMode && 'text-theme-500 bg-background')}
            onClick={() => {
              const next = !captureMode;
              setCaptureMode(next);
              if (!next) setPendingCapture(null);
            }}
          >
            <Scan size={14} />
          </IconButton>
        </div>
      </div>

      {/* ── Floating drag handle */}
      {pendingCapture && (
        <FloatingDragHandle
          sourceId={sourceId}
          text={pendingCapture.text}
          imageUrl={pendingCapture.imageUrl}
          capturing={pendingCapture.capturing}
          position={pendingCapture.position}
          onDismiss={() => setPendingCapture(null)}
          onSendToChat={handleSendToChat}
          onSetCover={onDataChange ? handleSetCover : undefined}
        />
      )}
    </div>
  );
};
