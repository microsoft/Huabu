// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Off-screen first-page renderer used by {@link PDFNode} to capture a
 * thumbnail when the node has no manual `coverUrl`.
 *
 * Lives in its own module so {@link PDFNode}'s import path doesn't pull
 * in `react-pdf` + `pdfjs-dist` (the worker is ~1 MB on its own). The
 * node statically renders a fast `<PreviewCard>` with the cached
 * thumbnail; only when a fresh capture is required is *this* module
 * loaded via `React.lazy`, which keeps the heavy pdf.js bundle out of
 * the initial canvas chunk.
 *
 * Once `coverUrl` is persisted the parent stops rendering this
 * component, so re-opening a canvas with cached covers never touches
 * pdf.js at all — exactly what we want for cold canvas-open time.
 */

import { memo, useCallback, useRef } from 'react';
import { Document, Page } from 'react-pdf';

import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

import { resolveArtifactUrl } from '@/api/artifact';

import { PDF_DOCUMENT_OPTIONS } from './pdfWorker';

/** Width used to render the first-page thumbnail canvas. */
const THUMBNAIL_WIDTH = 400;

interface FirstPageThumbnailProps {
  src: string;
  canvasId: string;
  onCapture: (dataUrl: string) => void;
}

export const FirstPageThumbnail = memo(function FirstPageThumbnail({
  src,
  canvasId,
  onCapture,
}: FirstPageThumbnailProps) {
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
});

// Default export so `React.lazy(() => import('./PDFFirstPageThumbnail'))`
// can pick it up without an extra `.then(m => ({ default: m.FirstPageThumbnail }))`.
export default FirstPageThumbnail;
