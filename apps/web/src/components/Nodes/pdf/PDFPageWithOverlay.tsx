// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import { useCallback, useRef, useState } from 'react';
import { Page } from 'react-pdf';

import 'react-pdf/dist/Page/TextLayer.css';

import { Loading } from '@/components/Common/Loading';

import type { PdfHighlight } from '@huabu/shared';

import './pdfWorker';

/** Minimal pdfjs page proxy shape we rely on. */
type PdfPageProxy = {
  getViewport: (opts: { scale: number }) => {
    width: number;
    height: number;
    convertToViewportPoint: (x: number, y: number) => [number, number];
  };
  getTextContent: () => Promise<{
    items: Array<{ str?: string; transform?: number[] }>;
  }>;
};

/** Normalized rect: all values 0–1, relative to the page container. */
export type NormalizedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AreaCapturedEvent = {
  pageIndex: number;
  captureRect: NormalizedRect;
  position: { x: number; y: number };
  /** Crops the pdfjs canvas bitmap to the selected region. */
  getBlob: () => Promise<Blob | null>;
  /** Extracts text items whose baseline falls within the selected region. */
  getText: () => Promise<string>;
};

type DragState = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

type PDFPageWithOverlayProps = {
  /** 1-based page number for react-pdf */
  pageNumber: number;
  /** 0-based page index for event data */
  pageIndex: number;
  /** Desired rendered width in px. When undefined the Page renders at its default size. */
  pageWidth?: number;
  /** When false (default), pointer events pass through and no capture overlay is shown. */
  captureEnabled?: boolean;
  onAreaCaptured: (event: AreaCapturedEvent) => void;
  /** When provided, the selection rectangle stays visible (e.g. while FloatingDragHandle is shown). */
  persistedRect?: NormalizedRect;
  /** Persistent highlights to render on this page. */
  highlights?: PdfHighlight[];
  onAspectRatioResolved?: (pageIndex: number, aspectRatio: number) => void;
};

export const PDFPageWithOverlay = ({
  pageNumber,
  pageIndex,
  pageWidth,
  captureEnabled = false,
  onAreaCaptured,
  persistedRect,
  highlights,
  onAspectRatioResolved,
}: PDFPageWithOverlayProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const pageProxyRef = useRef<PdfPageProxy | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [rendered, setRendered] = useState(false);

  // ---------------------------------------------------------------------------
  // Pointer handlers — only active when captureEnabled is true
  // ---------------------------------------------------------------------------
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!captureEnabled) return;
      const container = containerRef.current;
      if (!container) return;

      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);

      const rect = container.getBoundingClientRect();
      const startX = (e.clientX - rect.left) / rect.width;
      const startY = (e.clientY - rect.top) / rect.height;

      const state: DragState = {
        startX,
        startY,
        currentX: startX,
        currentY: startY,
      };
      dragRef.current = state;
      setDrag(state);
    },
    [captureEnabled],
  );

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const currentX = Math.min(
      Math.max((e.clientX - rect.left) / rect.width, 0),
      1,
    );
    const currentY = Math.min(
      Math.max((e.clientY - rect.top) / rect.height, 0),
      1,
    );

    const updated = { ...dragRef.current, currentX, currentY };
    dragRef.current = updated;
    setDrag({ ...updated });
  }, []);

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current) return;
      const container = containerRef.current;
      if (!container) return;

      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);

      const captureRect: NormalizedRect = {
        x: Math.min(d.startX, d.currentX),
        y: Math.min(d.startY, d.currentY),
        width: Math.abs(d.currentX - d.startX),
        height: Math.abs(d.currentY - d.startY),
      };

      // Ignore accidental tiny drags (< 2% of page dimension)
      if (captureRect.width < 0.02 || captureRect.height < 0.02) return;

      // Capture canvas reference synchronously so async getBlob is stable
      const pdfCanvas = container.querySelector('canvas');

      const getBlob = async (): Promise<Blob | null> => {
        if (!pdfCanvas) return null;

        const cw = pdfCanvas.width;
        const ch = pdfCanvas.height;
        const offscreen = document.createElement('canvas');
        offscreen.width = Math.round(captureRect.width * cw);
        offscreen.height = Math.round(captureRect.height * ch);
        const ctx = offscreen.getContext('2d');
        if (!ctx) return null;

        ctx.drawImage(
          pdfCanvas,
          captureRect.x * cw,
          captureRect.y * ch,
          captureRect.width * cw,
          captureRect.height * ch,
          0,
          0,
          offscreen.width,
          offscreen.height,
        );

        return new Promise<Blob | null>((resolve) =>
          offscreen.toBlob((b) => resolve(b), 'image/png'),
        );
      };

      const getText = async (): Promise<string> => {
        const page = pageProxyRef.current;
        if (!page) return '';

        // Derive scale: compare desired width against the page's natural (scale=1) width
        const naturalViewport = page.getViewport({ scale: 1 });
        const scale = pageWidth ? pageWidth / naturalViewport.width : 1;
        const viewport = page.getViewport({ scale });
        const textContent = await page.getTextContent();

        const words: string[] = [];
        for (const item of textContent.items) {
          const str = item.str?.trim();
          const transform = item.transform;
          if (!str || !transform || transform.length < 6) continue;

          // transform[4], transform[5] are the PDF-space glyph origin.
          // convertToViewportPoint maps them to viewport pixel coordinates
          // (top-left origin, matching what the canvas renders).
          const [vx, vy] = viewport.convertToViewportPoint(
            transform[4],
            transform[5],
          );
          // Normalize against the viewport dimensions to match captureRect (0–1)
          const nx = vx / viewport.width;
          const ny = vy / viewport.height;

          if (
            nx >= captureRect.x &&
            nx <= captureRect.x + captureRect.width &&
            ny >= captureRect.y &&
            ny <= captureRect.y + captureRect.height
          ) {
            words.push(str);
          }
        }

        return words.join(' ').replace(/\s+/g, ' ').trim();
      };

      onAreaCaptured({
        pageIndex,
        captureRect,
        position: { x: e.clientX, y: e.clientY },
        getBlob,
        getText,
      });
    },
    [pageIndex, pageWidth, onAreaCaptured],
  );

  // ---------------------------------------------------------------------------
  // Selection rect style for visual feedback during drag or persisted capture
  // ---------------------------------------------------------------------------
  const selectionStyle = drag
    ? {
        left: `${Math.min(drag.startX, drag.currentX) * 100}%`,
        top: `${Math.min(drag.startY, drag.currentY) * 100}%`,
        width: `${Math.abs(drag.currentX - drag.startX) * 100}%`,
        height: `${Math.abs(drag.currentY - drag.startY) * 100}%`,
      }
    : persistedRect
      ? {
          left: `${persistedRect.x * 100}%`,
          top: `${persistedRect.y * 100}%`,
          width: `${persistedRect.width * 100}%`,
          height: `${persistedRect.height * 100}%`,
        }
      : null;

  return (
    // When capture mode is off, renderTextLayer is enabled so users can
    // select/copy text normally.  In capture mode the text layer is hidden
    // and text is extracted programmatically via pdfjs getTextContent().
    <div
      ref={containerRef}
      data-pdf-page-index={pageIndex}
      // Capture drags are horizontal too, so they must outrank the panel's
      // arrow shortcuts and swipe navigation.
      data-expanded-node-arrow-owner={captureEnabled ? '' : undefined}
      className={clsx(
        'relative',
        !rendered && 'min-h-40',
        captureEnabled ? 'cursor-crosshair select-none' : 'select-auto',
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <Page
        pageNumber={pageNumber}
        width={pageWidth}
        renderAnnotationLayer={false}
        renderTextLayer={!captureEnabled}
        loading=""
        onLoadSuccess={(page) => {
          pageProxyRef.current = page as unknown as PdfPageProxy;
          const viewport = page.getViewport({ scale: 1 });
          onAspectRatioResolved?.(pageIndex, viewport.width / viewport.height);
        }}
        onRenderSuccess={(p) => {
          pageProxyRef.current = p as unknown as PdfPageProxy;
          setRendered(true);
        }}
      />

      {/* Spinner overlay until canvas is actually painted */}
      {!rendered && <Loading layout="overlay" variant="skeleton" />}

      {/* Selection box feedback (shown while dragging) */}
      {selectionStyle && (
        <div
          className="pointer-events-none absolute"
          style={{
            ...selectionStyle,
            border: '1.5px dashed var(--pdf-selection-border)',
            background: 'var(--pdf-selection-bg)',
            borderRadius: '3px',
          }}
        />
      )}

      {/* Persistent highlights */}
      {highlights?.map((hl) =>
        hl.rects.map((r, i) => (
          <div
            key={`${hl.id}-${i}`}
            className="pointer-events-none absolute"
            style={{
              left: `${r.x * 100}%`,
              top: `${r.y * 100}%`,
              width: `${r.width * 100}%`,
              height: `${r.height * 100}%`,
              background: 'var(--pdf-highlight-bg)',
              mixBlendMode: 'multiply',
            }}
          />
        )),
      )}
    </div>
  );
};
