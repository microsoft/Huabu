// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import { Highlighter, Scan } from 'lucide-react';
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Document } from 'react-pdf';

import { resolveArtifactUrl, uploadImage } from '@/api/artifact';
import { usePreviewHeaderSlot } from '@/components/Nodes/PreviewHeaderSlot';
import { useRegisterPreviewSearchAdapter } from '@/components/Panels/ExpandedNodePanel/PreviewSearchAdapterContext';
import {
  computeHighlightUpdate,
  mergeLineRects,
} from '@/handler/pdfHighlight/highlight';
import { scheduleScrollToMatch } from '@/hooks/searchDom';
import { usePreviewScrollMemory } from '@/hooks/usePreviewScrollMemory';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { conversationViewForNode } from '@/store/conversationOwner';
import { usePanelStore } from '@/store/panelStore';
import { usePreviewSearchStore } from '@/store/previewSearchStore';
import {
  conversationInOtherGroup,
  findTabByTarget,
  groupOfTab,
} from '@/store/previewWorkspace/model';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';

import { FloatingDragHandle } from '../FloatingDragHandle';
import {
  DEFAULT_PDF_PAGE_ASPECT_RATIO,
  updateRetainedPdfPages,
  updateVisiblePdfPages,
} from './pdfPageRendering';
import { PDFPageWithOverlay } from './PDFPageWithOverlay';
import { findPdfTextMatches } from './pdfTextIndex';
import { PDF_DOCUMENT_OPTIONS } from './pdfWorker';
import { usePdfDocumentLifecycle } from './usePdfDocumentLifecycle';
import { usePdfTextIndex } from './usePdfTextIndex';
import { Button } from '../../Common/Button';
import { Loading } from '../../Common/Loading';

import type { AreaCapturedEvent, NormalizedRect } from './PDFPageWithOverlay';
import type { PreviewComponentProps } from '../note/NotePreview';
import type { ChatAttachment, PdfHighlight } from '@huabu/shared';

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

export const PDFPreview = ({
  id,
  data,
  scrollViewKey,
  onDataChange,
}: PreviewComponentProps) => {
  const { t } = useTranslation();
  const src = typeof data.src === 'string' ? data.src : '';
  const canvasId = useCanvasStore((s) => s.canvasId);
  const resolvedSrc = resolveArtifactUrl(src, canvasId);
  const previewSearchNodeId = usePreviewSearchStore((s) => s.nodeId);
  const searchQuery = usePreviewSearchStore((s) => s.query);
  const isPreviewSearchOpen = usePreviewSearchStore((s) => s.isOpen);
  const {
    document: pdfDocument,
    numPages,
    isLoaded: docLoaded,
    handleLoadSuccess: onDocumentLoadSuccess,
  } = usePdfDocumentLifecycle(src);
  const [forcedPageIndex, setForcedPageIndex] = useState<number | null>(null);
  const searchNavigationCancelRef = useRef<(() => void) | null>(null);
  const [visiblePageIndexes, setVisiblePageIndexes] = useState<
    ReadonlySet<number>
  >(() => new Set([0]));
  const [retainedPageIndexes, setRetainedPageIndexes] = useState<
    ReadonlySet<number>
  >(() => new Set([0]));
  const [pageAspectRatios, setPageAspectRatios] = useState<
    ReadonlyMap<number, number>
  >(() => new Map());
  // Reset loading state when the PDF source changes.
  useEffect(() => {
    setForcedPageIndex(null);
    setVisiblePageIndexes(new Set([0]));
    setRetainedPageIndexes(new Set([0]));
    setPageAspectRatios(new Map());
  }, [src]);
  const [captureMode, setCaptureMode] = useState(false);
  const [highlightMode, setHighlightMode] = useState(false);
  const [pendingCapture, setPendingCapture] =
    useState<PendingCaptureDrag | null>(null);
  // Text selected via the browser's native selection (non-capture mode).
  const [pendingTextSelection, setPendingTextSelection] = useState<{
    text: string;
    position: { x: number; y: number };
  } | null>(null);

  // Persistent highlights stored in node data.
  const highlights: PdfHighlight[] = useMemo(
    () =>
      Array.isArray(data.highlights) ? (data.highlights as PdfHighlight[]) : [],
    [data.highlights],
  );
  const highlightsRef = useRef(highlights);
  highlightsRef.current = highlights;
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  usePreviewScrollMemory(scrollContainerRef, scrollViewKey);
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

  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root || !numPages) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const changes = entries.flatMap((entry) => {
          const pageIndex = Number(
            (entry.target as HTMLElement).dataset.pdfPageShell,
          );
          return Number.isInteger(pageIndex)
            ? [{ pageIndex, isVisible: entry.isIntersecting }]
            : [];
        });
        startTransition(() => {
          setVisiblePageIndexes((current) =>
            updateVisiblePdfPages(current, changes),
          );
          setRetainedPageIndexes((current) =>
            updateRetainedPdfPages(current, changes),
          );
        });
      },
      { root, rootMargin: '100% 0px' },
    );

    root
      .querySelectorAll<HTMLElement>('[data-pdf-page-shell]')
      .forEach((page) => observer.observe(page));
    return () => observer.disconnect();
  }, [numPages]);

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

  // ---------------------------------------------------------------------------
  // Native text selection → FloatingDragHandle (non-capture mode only)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (captureMode || highlightMode) {
      setPendingTextSelection(null);
      return;
    }
    const el = scrollContainerRef.current;
    if (!el) return;

    const handleMouseUp = (e: MouseEvent) => {
      // Small delay lets the browser finalise the selection range.
      requestAnimationFrame(() => {
        const sel = window.getSelection();
        const text = sel?.toString().trim();
        if (!text) return;

        // Only act when the selection lives inside a .textLayer within *this* container.
        const anchor = sel?.anchorNode;
        if (
          !anchor ||
          !el.contains(anchor as Node) ||
          !(anchor as Node).parentElement?.closest('.textLayer')
        )
          return;

        setPendingTextSelection({
          text,
          position: { x: e.clientX, y: e.clientY },
        });
      });
    };

    el.addEventListener('mouseup', handleMouseUp);
    return () => el.removeEventListener('mouseup', handleMouseUp);
  }, [captureMode, highlightMode]);

  // Dismiss text-selection handle when selection is cleared or on scroll.
  useEffect(() => {
    if (!pendingTextSelection) return;

    const handleSelectionChange = () => {
      const text = window.getSelection()?.toString().trim();
      if (!text) setPendingTextSelection(null);
    };
    document.addEventListener('selectionchange', handleSelectionChange);

    const el = scrollContainerRef.current;
    const handleScroll = () => setPendingTextSelection(null);
    el?.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      el?.removeEventListener('scroll', handleScroll);
    };
  }, [pendingTextSelection]);

  // ---------------------------------------------------------------------------
  // Highlight mode: select text → toggle yellow highlight rects
  //
  // If the selection contains any unhighlighted area → add only the new parts.
  // If the selection is fully covered by existing highlights → remove those
  // highlights (toggle-off).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!highlightMode) return;
    const el = scrollContainerRef.current;
    if (!el) return;

    const handleMouseUp = () => {
      requestAnimationFrame(() => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const text = sel.toString().trim();
        if (!text) return;

        const range = sel.getRangeAt(0);
        const clientRects = range.getClientRects();
        if (clientRects.length === 0) return;

        // Group client rects by page container (normalized 0–1 coordinates).
        const pageContainers = el.querySelectorAll<HTMLElement>(
          '[data-pdf-page-index]',
        );
        const grouped = new Map<
          number,
          { x: number; y: number; width: number; height: number }[]
        >();

        for (const cr of clientRects) {
          for (const pc of pageContainers) {
            const pageRect = pc.getBoundingClientRect();
            if (
              cr.top >= pageRect.top - 2 &&
              cr.bottom <= pageRect.bottom + 2 &&
              cr.left >= pageRect.left - 2 &&
              cr.right <= pageRect.right + 2
            ) {
              const pageIdx = Number(pc.dataset.pdfPageIndex);
              const normalized = {
                x: (cr.left - pageRect.left) / pageRect.width,
                y: (cr.top - pageRect.top) / pageRect.height,
                width: cr.width / pageRect.width,
                height: cr.height / pageRect.height,
              };
              if (!grouped.has(pageIdx)) grouped.set(pageIdx, []);
              const arr = grouped.get(pageIdx);
              if (arr) arr.push(normalized);
              break;
            }
          }
        }

        if (grouped.size === 0) return;

        // Deduplicate & merge overlapping rects per page.
        for (const [pageIdx, rects] of grouped) {
          grouped.set(pageIdx, mergeLineRects(rects));
        }

        const updated = computeHighlightUpdate(highlightsRef.current, grouped);
        onDataChange?.({ highlights: updated });
        sel.removeAllRanges();
      });
    };

    el.addEventListener('mouseup', handleMouseUp);
    return () => el.removeEventListener('mouseup', handleMouseUp);
  }, [highlightMode, onDataChange]);

  // CSS transform scales the already-rendered canvas in real-time.
  // Once the debounced re-render fires, scaleFactor returns to ~1 and the
  // canvas is at native resolution again → no visual jump.
  const scaleFactor =
    renderedWidth > 0 && containerWidth > 0
      ? containerWidth / renderedWidth
      : 1;

  const handlePageAspectRatioResolved = useCallback(
    (pageIndex: number, aspectRatio: number) => {
      setPageAspectRatios((current) => {
        if (current.get(pageIndex) === aspectRatio) return current;
        const next = new Map(current);
        next.set(pageIndex, aspectRatio);
        return next;
      });
    },
    [],
  );

  const isPdfSearchActive =
    isPreviewSearchOpen &&
    previewSearchNodeId === id &&
    searchQuery.trim().length > 0;
  const textIndex = usePdfTextIndex({
    document: pdfDocument,
    enabled: isPdfSearchActive,
    onPageAspectRatio: handlePageAspectRatioResolved,
  });
  const searchMatches = useMemo(
    () => findPdfTextMatches(textIndex.pages.values(), searchQuery),
    [searchQuery, textIndex.pages],
  );

  const navigateToSearchMatch = useCallback(
    (matchIndex: number) => {
      const match = searchMatches[matchIndex] ?? searchMatches[0];
      const root = scrollContainerRef.current;
      if (!match || !root) return;

      searchNavigationCancelRef.current?.();
      setForcedPageIndex(match.pageIndex);
      const pageShell = root.querySelector<HTMLElement>(
        `[data-pdf-page-shell="${match.pageIndex}"]`,
      );
      pageShell?.scrollIntoView({ block: 'center', behavior: 'auto' });
      searchNavigationCancelRef.current = scheduleScrollToMatch(
        () => pageShell,
        searchQuery.trim(),
        match.pageOccurrenceIndex,
      );
    },
    [searchMatches, searchQuery],
  );

  useEffect(() => {
    return () => {
      searchNavigationCancelRef.current?.();
      searchNavigationCancelRef.current = null;
      setForcedPageIndex(null);
    };
  }, [searchQuery]);

  const searchAdapter = useMemo(
    () =>
      isPdfSearchActive
        ? {
            matchCount: searchMatches.length,
            isSearching: textIndex.isIndexing,
            canNavigate: !textIndex.isIndexing,
            navigateToMatch: navigateToSearchMatch,
          }
        : null,
    [
      isPdfSearchActive,
      navigateToSearchMatch,
      searchMatches.length,
      textIndex.isIndexing,
    ],
  );
  useRegisterPreviewSearchAdapter(searchAdapter);

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
          const canvasId = useCanvasStore.getState().canvasId;
          if (!canvasId) throw new Error('No active canvas');
          const url = await uploadImage(file, canvasId);

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
      if (!id) return;

      const chat = useChatStore.getState();
      const canvas = useCanvasStore.getState();
      const preview = usePreviewWorkspaceStore.getState();
      const pdfTarget = { kind: 'node', canvasId, nodeId: id } as const;
      const adjacentConversation = conversationInOtherGroup(
        preview.workspace,
        pdfTarget,
        (nodeId) => {
          const node = canvas.nodes.find(
            (candidate) => candidate.id === nodeId,
          );
          if (!node) return undefined;
          return (
            conversationViewForNode(
              node,
              canvasId,
              canvas.worldReferences[nodeId],
            )?.conversationOwner.threadId ?? undefined
          );
        },
      );

      usePanelStore.getState().requestOpenRightPanel();
      if (adjacentConversation) {
        chat.addPendingAttachment(adjacentConversation.threadId, attachment);
        preview.promoteTab(adjacentConversation.tabId);
        usePanelStore
          .getState()
          .requestFocusChatInput(adjacentConversation.threadId);
        return;
      }

      const fallbackThreadId = chat.ensureCanvasThread(canvasId);
      const pdfTab = findTabByTarget(preview.workspace, pdfTarget);
      const pdfGroup = pdfTab ? groupOfTab(preview.workspace, pdfTab.id) : null;
      chat.addPendingAttachment(fallbackThreadId, attachment);
      preview.openPreviewTarget(
        { kind: 'chat', canvasId, threadId: fallbackThreadId },
        { groupId: pdfGroup?.id, openToSide: true },
      );
      usePanelStore.getState().requestFocusChatInput(fallbackThreadId);
    },
    [canvasId, id],
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

  // Host header slot — rendered by `ExpandedNodePanel`. When present
  // we portal the capture / highlight toggles into the shared header
  // (same pattern as NotePreview / WebPreview / OfficePreview) so they
  // sit next to the universal Split view / Close buttons instead of
  // floating over the PDF content. In surfaces that don't provide a
  // slot (e.g. the canvas node form), `el` is null and the toolbar
  // simply isn't rendered.
  const { el: headerSlotEl } = usePreviewHeaderSlot();
  const headerActions = (
    <>
      <Button
        variant="ghost"
        tone="neutral"
        size="sm"
        iconOnly
        title={t('node.selectArea')}
        tooltipPlacement="bottom"
        aria-label={t('node.selectAreaToCapture')}
        aria-pressed={captureMode}
        className={clsx(captureMode && 'text-info bg-bg-default')}
        onClick={() => {
          const next = !captureMode;
          setCaptureMode(next);
          if (next) setHighlightMode(false);
          if (!next) setPendingCapture(null);
        }}
      >
        <Scan />
      </Button>
      <Button
        variant="ghost"
        tone="neutral"
        size="sm"
        iconOnly
        title={t('node.highlightText')}
        tooltipPlacement="bottom"
        aria-label={t('node.highlightText')}
        aria-pressed={highlightMode}
        className={clsx(highlightMode && 'bg-bg-default text-warning-light')}
        onClick={() => {
          const next = !highlightMode;
          setHighlightMode(next);
          if (next) {
            setCaptureMode(false);
            setPendingCapture(null);
          }
        }}
      >
        <Highlighter />
      </Button>
    </>
  );

  return (
    <div className="relative flex h-full flex-col">
      {headerSlotEl ? createPortal(headerActions, headerSlotEl) : null}
      {/* Loading overlay — visible until document metadata is parsed */}
      {src && !docLoaded && <Loading layout="overlay" variant="skeleton" />}
      {/* ── PDF pages ── */}
      <div
        ref={scrollContainerRef}
        className="bg-surface flex-1 overflow-x-hidden overflow-y-auto p-1"
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
              file={resolvedSrc}
              options={PDF_DOCUMENT_OPTIONS}
              onLoadSuccess={onDocumentLoadSuccess}
              loading=""
              error={
                <div className="text-danger-light p-4 text-xs">
                  {t('node.errorLoadingPdf')}
                </div>
              }
              className={clsx('flex flex-col items-center gap-0')}
            >
              {Array.from(new Array(numPages ?? 0), (_el, index) => (
                <div
                  key={`page_${index + 1}`}
                  data-pdf-page-shell={index}
                  className="bg-bg-default w-full"
                  style={{
                    aspectRatio:
                      pageAspectRatios.get(index) ??
                      pageAspectRatios.get(0) ??
                      DEFAULT_PDF_PAGE_ASPECT_RATIO,
                  }}
                >
                  {visiblePageIndexes.has(index) ||
                  retainedPageIndexes.has(index) ||
                  forcedPageIndex === index ? (
                    <PDFPageWithOverlay
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
                      highlights={highlights.filter(
                        (h) => h.pageIndex === index,
                      )}
                      onAspectRatioResolved={handlePageAspectRatioResolved}
                    />
                  ) : null}
                </div>
              ))}
            </Document>
          </div>
        ) : (
          <div className="text-fg-subtle flex h-full w-full items-center justify-center text-sm">
            {t('node.noPdfSource')}
          </div>
        )}
      </div>

      {/* ── Floating drag handle (area capture) */}
      {pendingCapture && (
        <FloatingDragHandle
          excerptFromNodeId={id}
          text={pendingCapture.text}
          imageUrl={pendingCapture.imageUrl}
          capturing={pendingCapture.capturing}
          position={pendingCapture.position}
          onDismiss={() => setPendingCapture(null)}
          onSendToChat={handleSendToChat}
          onSetCover={onDataChange ? handleSetCover : undefined}
        />
      )}

      {/* ── Floating drag handle (native text selection) */}
      {pendingTextSelection && !pendingCapture && (
        <FloatingDragHandle
          excerptFromNodeId={id}
          text={pendingTextSelection.text}
          imageUrl={null}
          capturing={false}
          position={pendingTextSelection.position}
          onDismiss={() => setPendingTextSelection(null)}
        />
      )}
    </div>
  );
};
