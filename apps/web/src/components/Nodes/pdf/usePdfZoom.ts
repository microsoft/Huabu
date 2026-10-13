// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import {
  readPdfPreviewView,
  rememberPdfPreviewView,
} from '@/store/previewWorkspace/scrollMemory';

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const clampScale = (scale: number) =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

type ZoomMode = 'width' | 'page' | 'custom';

export function usePdfZoom({
  containerRef,
  source,
  viewKey,
  embedded,
  naturalWidth,
  aspectRatio,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  source: string;
  viewKey: string | undefined;
  embedded: boolean;
  naturalWidth: number;
  aspectRatio: number;
}) {
  const memoryKey = embedded ? undefined : viewKey;
  const [zoom, setZoom] = useState(() => {
    const saved = readPdfPreviewView(memoryKey);
    return {
      source,
      memoryKey,
      mode: saved?.source === source ? saved.mode : ('width' as ZoomMode),
      scale: saved?.source === source ? saved.scale : 1,
    };
  });
  if (zoom.source !== source || zoom.memoryKey !== memoryKey) {
    const saved = readPdfPreviewView(memoryKey);
    setZoom({
      source,
      memoryKey,
      mode: saved?.source === source ? saved.mode : 'width',
      scale: saved?.source === source ? saved.scale : 1,
    });
  }
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [renderedWidth, setRenderedWidth] = useState(0);
  const anchorRef = useRef<{
    x: number;
    y: number;
    scrollTop: number;
    scrollLeft: number;
  } | null>(null);
  const previousWidthRef = useRef(0);
  const previousViewportWidthRef = useRef(0);
  const previousIdentityRef = useRef({ source, memoryKey });
  const savedView = readPdfPreviewView(memoryKey);
  const pendingHorizontalRef = useRef<number | null>(
    savedView?.source === source ? savedView.scrollLeft : null,
  );

  useEffect(() => {
    const viewport = containerRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      // Activity-hidden tabs report zero size; keep their reading geometry.
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [containerRef]);

  const mode = embedded ? 'width' : zoom.mode;
  const scale =
    mode === 'custom'
      ? zoom.scale
      : Math.min(
          size.width / naturalWidth,
          mode === 'page'
            ? (size.height * aspectRatio) / naturalWidth
            : Infinity,
        );
  const pageWidth = Math.max(0, naturalWidth * scale);

  useEffect(() => {
    if (pageWidth <= 0) return;
    if (renderedWidth === 0) {
      setRenderedWidth(pageWidth);
      return;
    }
    const ratio = pageWidth / renderedWidth;
    if (ratio <= 1.15 && ratio >= 0.75) return;
    const timer = setTimeout(() => setRenderedWidth(pageWidth), 400);
    return () => clearTimeout(timer);
  }, [pageWidth, renderedWidth]);

  useLayoutEffect(() => {
    const viewport = containerRef.current;
    if (!viewport || pageWidth <= 0 || size.width <= 0) return;
    if (
      previousIdentityRef.current.source !== source ||
      previousIdentityRef.current.memoryKey !== memoryKey
    ) {
      previousWidthRef.current = 0;
      anchorRef.current = null;
      previousIdentityRef.current = { source, memoryKey };
      const saved = readPdfPreviewView(memoryKey);
      pendingHorizontalRef.current =
        saved?.source === source ? saved.scrollLeft : null;
      viewport.scrollLeft = 0;
    }
    const previousWidth = previousWidthRef.current;
    const previousViewportWidth = previousViewportWidthRef.current;
    previousWidthRef.current = pageWidth;
    previousViewportWidthRef.current = size.width;
    if (previousWidth > 0 && previousWidth !== pageWidth) {
      const anchor = anchorRef.current ?? {
        x: size.width / 2,
        y: size.height / 2,
        scrollTop: viewport.scrollTop,
        scrollLeft: viewport.scrollLeft,
      };
      const ratio = pageWidth / previousWidth;
      const oldLeft = Math.max(0, (previousViewportWidth - previousWidth) / 2);
      const newLeft = Math.max(0, (size.width - pageWidth) / 2);
      viewport.scrollLeft = Math.max(
        0,
        (anchor.scrollLeft + anchor.x - oldLeft) * ratio + newLeft - anchor.x,
      );
      viewport.scrollTop = Math.max(
        0,
        (anchor.scrollTop + anchor.y) * ratio - anchor.y,
      );
    }
    anchorRef.current = null;
  }, [containerRef, memoryKey, pageWidth, size, source]);

  useEffect(() => {
    const viewport = containerRef.current;
    if (!viewport || pendingHorizontalRef.current === null) return;
    const restore = () => {
      const desired = pendingHorizontalRef.current;
      if (desired === null || viewport.closest('[data-preview-active="false"]'))
        return;
      viewport.scrollLeft = desired;
      if (Math.abs(viewport.scrollLeft - desired) < 1) {
        pendingHorizontalRef.current = null;
        resizeObserver.disconnect();
        mutationObserver.disconnect();
      }
    };
    const resizeObserver = new ResizeObserver(restore);
    const mutationObserver = new MutationObserver(restore);
    resizeObserver.observe(viewport);
    if (viewport.firstElementChild) {
      resizeObserver.observe(viewport.firstElementChild);
      mutationObserver.observe(viewport.firstElementChild, {
        childList: true,
        subtree: true,
      });
    }
    const takeOver = () => {
      pendingHorizontalRef.current = null;
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
    restore();
    viewport.addEventListener('wheel', takeOver, { passive: true });
    viewport.addEventListener('pointerdown', takeOver, { passive: true });
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      viewport.removeEventListener('wheel', takeOver);
      viewport.removeEventListener('pointerdown', takeOver);
    };
  }, [containerRef, memoryKey, pageWidth, source]);

  const captureAnchor = useCallback(
    (point?: { clientX: number; clientY: number }) => {
      const viewport = containerRef.current;
      if (!viewport) return;
      const bounds = viewport.getBoundingClientRect();
      const style = getComputedStyle(viewport);
      anchorRef.current = {
        x: point
          ? point.clientX -
            bounds.left -
            viewport.clientLeft -
            Number.parseFloat(style.paddingLeft || '0')
          : size.width / 2,
        y: point
          ? point.clientY -
            bounds.top -
            viewport.clientTop -
            Number.parseFloat(style.paddingTop || '0')
          : size.height / 2,
        scrollTop: viewport.scrollTop,
        scrollLeft: viewport.scrollLeft,
      };
    },
    [containerRef, size],
  );

  const setScale = useCallback(
    (next: number) => {
      captureAnchor();
      setZoom({ source, memoryKey, mode: 'custom', scale: clampScale(next) });
    },
    [captureAnchor, source, memoryKey],
  );

  useEffect(() => {
    const viewport = containerRef.current;
    if (embedded || !viewport) return;
    const onWheel = (event: WheelEvent) => {
      // Chromium sends trackpad pinch as Ctrl+wheel, including on macOS.
      if (!event.ctrlKey || pageWidth <= 0) return;
      event.preventDefault();
      event.stopPropagation();
      captureAnchor(event);
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1);
      setZoom((current) => ({
        source,
        memoryKey,
        mode: 'custom',
        scale: clampScale(
          (current.mode === 'custom' ? current.scale : scale) *
            Math.exp(-delta / 300),
        ),
      }));
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [
    captureAnchor,
    containerRef,
    embedded,
    memoryKey,
    pageWidth,
    scale,
    size.height,
    source,
  ]);

  useLayoutEffect(() => {
    const viewport = containerRef.current;
    if (!viewport || !memoryKey || size.width <= 0) return;
    const remember = () => {
      if (viewport.closest('[data-preview-active="false"]')) return;
      rememberPdfPreviewView(memoryKey, {
        source,
        mode: zoom.mode,
        scale: zoom.scale,
        scrollLeft: pendingHorizontalRef.current ?? viewport.scrollLeft,
        naturalWidth,
        aspectRatio,
      });
    };
    remember();
    viewport.addEventListener('scroll', remember, { passive: true });
    return () => {
      remember();
      viewport.removeEventListener('scroll', remember);
    };
  }, [
    aspectRatio,
    containerRef,
    memoryKey,
    naturalWidth,
    size.width,
    source,
    zoom,
  ]);

  return {
    mode,
    scale,
    pageWidth,
    renderedWidth,
    scaleFactor: renderedWidth > 0 ? pageWidth / renderedWidth : 1,
    zoomIn: () => setScale(scale + 0.25),
    zoomOut: () => setScale(scale - 0.25),
    resetZoom: () => setScale(1),
    canZoomIn: scale < MAX_SCALE,
    canZoomOut: scale > MIN_SCALE,
    fit: (nextMode: 'width' | 'page') => {
      captureAnchor();
      setZoom({ source, memoryKey, mode: nextMode, scale: 1 });
    },
  };
}
