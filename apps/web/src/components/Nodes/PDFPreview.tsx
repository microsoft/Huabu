import clsx from 'clsx';
import { Crop } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Document } from 'react-pdf';

import { uploadImage } from '@/api/artifact';

import { FloatingDragHandle } from './FloatingDragHandle';
import { PDFPageWithOverlay } from './PDFPageWithOverlay';

import type { PreviewComponentProps } from './NotePreview';
import type { AreaCapturedEvent } from './PDFPageWithOverlay';

type PendingCaptureDrag = {
  /** Text extracted from the captured region (empty string = none found) */
  text: string;
  imageUrl: string | null;
  capturing: boolean;
  uploadError: boolean;
  position: { x: number; y: number };
  retryFn: () => void;
};

export const PDFPreview = ({ data }: PreviewComponentProps) => {
  const src = typeof data.src === 'string' ? data.src : '';
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pendingCapture, setPendingCapture] =
    useState<PendingCaptureDrag | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  // renderedWidth is captured once and never updated — the PDF canvas is
  // rendered at this fixed size, and CSS transform handles all subsequent
  // container resizes.  This avoids react-pdf re-renders (and blank flashes)
  // entirely.
  const renderedWidthRef = useRef<number>(0);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const available = entry.contentRect.width;
      if (available > 0) {
        // Lock the render width to the first measurement
        if (renderedWidthRef.current === 0) {
          renderedWidthRef.current = available;
        }
        setContainerWidth(available);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const renderedWidth = renderedWidthRef.current;

  // CSS transform scales the already-rendered canvas — no re-render needed.
  const scaleFactor =
    renderedWidth > 0 && containerWidth > 0
      ? containerWidth / renderedWidth
      : 1;

  const onDocumentLoadSuccess = useCallback(
    ({ numPages: n }: { numPages: number }) => {
      setNumPages(n);
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Area-capture handler
  // ---------------------------------------------------------------------------
  const handleAreaCaptured = useCallback(
    ({ position, getBlob, getText }: AreaCapturedEvent) => {
      const doCapture = async () => {
        setPendingCapture({
          text: '',
          imageUrl: null,
          capturing: true,
          uploadError: false,
          position,
          retryFn: doCapture,
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
            return { ...prev, capturing: false, uploadError: true };
          });
        }
      };

      void doCapture();
    },
    [setPendingCapture],
  );

  return (
    <div className="flex h-full flex-col">
      {/* ── Hint bar ── */}
      <div className="border-border flex shrink-0 items-center gap-1.5 border-b px-3 py-1.5">
        <Crop size={12} className="text-muted-foreground shrink-0" />
        <span className="text-muted-foreground text-xs">
          Draw a region on the page to capture text or image
        </span>
      </div>

      {/* ── PDF pages ── */}
      <div
        ref={scrollContainerRef}
        className="custom-scrollbar flex-1 overflow-auto bg-white p-1"
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
              loading={
                <div className="text-muted-foreground p-4 text-xs">
                  Loading…
                </div>
              }
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
                  onAreaCaptured={handleAreaCaptured}
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

      {/* ── Floating drag handle (rendered via React Portal to document.body) ── */}
      {pendingCapture && (
        <FloatingDragHandle
          text={pendingCapture.text}
          imageUrl={pendingCapture.imageUrl}
          capturing={pendingCapture.capturing}
          uploadError={pendingCapture.uploadError}
          onRetry={pendingCapture.retryFn}
          position={pendingCapture.position}
          onDismiss={() => setPendingCapture(null)}
        />
      )}
    </div>
  );
};
