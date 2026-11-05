// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import { Highlighter, Scan, Trash2 } from 'lucide-react';
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
import { TextSelectionToolbar } from '@/components/Messages/TextSelectionToolbar';
import { PreviewHeaderButton } from '@/components/Nodes/PreviewHeaderButton';
import { usePreviewHeaderSlot } from '@/components/Nodes/PreviewHeaderSlot';
import { useRegisterPreviewSearchAdapter } from '@/components/Panels/ExpandedNodePanel/PreviewSearchAdapterContext';
import { computeHighlightUpdate } from '@/handler/pdfHighlight/highlight';
import { scheduleScrollToMatch, findProjectedRange } from '@/hooks/searchDom';
import { handleCanvasNavigationKey } from '@/hooks/shortcuts/handleCanvasNavigationKey';
import { usePreviewScrollMemory } from '@/hooks/usePreviewScrollMemory';
import { hashSearchSource } from '@/hooks/useSearchSource';
import { loadDefaultAgentBinding } from '@/store/acpProfilesStore';
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
import { readPdfPreviewView } from '@/store/previewWorkspace/scrollMemory';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';
import { setDragPayload } from '@/utils/io/dragDrop';
import { pageLifecycle } from '@/utils/pageLifecycle';

import { FloatingDragHandle } from '../FloatingDragHandle';
import {
  DEFAULT_PDF_PAGE_ASPECT_RATIO,
  updateRetainedPdfPages,
  updateVisiblePdfPages,
} from './pdfPageRendering';
import { PDFPageWithOverlay } from './PDFPageWithOverlay';
import {
  readPdfSelection,
  readPdfHighlightText,
  type PdfTextSelection,
} from './pdfSelection';
import { findPdfTextMatches, findPdfSourceMatch } from './pdfTextIndex';
import { PDF_DOCUMENT_OPTIONS } from './pdfWorker';
import { PDFZoomControls } from './PDFZoomControls';
import { usePdfDocumentLifecycle } from './usePdfDocumentLifecycle';
import { usePdfTextIndex } from './usePdfTextIndex';
import { usePdfZoom } from './usePdfZoom';
import { Button } from '../../Common/Button';
import { Loading } from '../../Common/Loading';
import { toast } from '../../Common/Toast';
import { containNoteWheel } from '../note/noteScroll';

import type { AreaCapturedEvent, NormalizedRect } from './PDFPageWithOverlay';
import type { PreviewComponentProps } from '../note/NotePreview';
import type { PreviewSearchAdapter } from '@/components/Panels/ExpandedNodePanel/PreviewSearchAdapterContext';
import type { ChatAttachment, PdfHighlight } from '@huabu/shared';

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

type PDFPreviewProps = PreviewComponentProps & {
  /** Reuse the page renderer without Preview Workspace tools or state. */
  embedded?: boolean;
  /** Canvas readers accept input only while their node is solely selected. */
  interactive?: boolean;
};

function RegisterPDFSearch({
  adapter,
}: {
  adapter: PreviewSearchAdapter | null;
}) {
  useRegisterPreviewSearchAdapter(adapter);
  return null;
}

export const PDFPreview = ({
  id,
  data,
  scrollViewKey,
  onDataChange,
  embedded = false,
  interactive = true,
}: PDFPreviewProps) => {
  const { t } = useTranslation();
  const src = typeof data.src === 'string' ? data.src : '';
  const canvasId = useCanvasStore((s) => s.canvasId);
  const resolvedSrc = resolveArtifactUrl(src, canvasId);
  const previewSearchNodeId = usePreviewSearchStore((s) =>
    embedded ? null : s.nodeId,
  );
  const searchQuery = usePreviewSearchStore((s) => (embedded ? '' : s.query));
  const isPreviewSearchOpen = usePreviewSearchStore((s) =>
    embedded ? false : s.isOpen,
  );
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const loadError = failedSource === src;
  const [loadAttempt, setLoadAttempt] = useState(0);
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
  >(() => {
    const saved = readPdfPreviewView(embedded ? undefined : scrollViewKey);
    return saved?.source === src
      ? new Map([[0, saved.aspectRatio]])
      : new Map();
  });
  const [naturalPageWidth, setNaturalPageWidth] = useState(() => {
    const saved = readPdfPreviewView(embedded ? undefined : scrollViewKey);
    return saved?.source === src ? saved.naturalWidth : 612;
  });
  // Reset loading state when the PDF source changes.
  useEffect(() => {
    setFailedSource(null);
    setForcedPageIndex(null);
    setVisiblePageIndexes(new Set([0]));
    setRetainedPageIndexes(new Set([0]));
    const saved = readPdfPreviewView(embedded ? undefined : scrollViewKey);
    setPageAspectRatios(
      saved?.source === src ? new Map([[0, saved.aspectRatio]]) : new Map(),
    );
    setNaturalPageWidth(saved?.source === src ? saved.naturalWidth : 612);
  }, [src, embedded, scrollViewKey]);
  const [captureMode, setCaptureMode] = useState(false);
  const [pendingCapture, setPendingCapture] =
    useState<PendingCaptureDrag | null>(null);
  // Text selected via the browser's native selection (non-capture mode).
  const [pendingTextSelection, setPendingTextSelection] =
    useState<PdfTextSelection | null>(null);
  const [editingComment, setEditingComment] = useState(false);
  useEffect(() => {
    setPendingTextSelection(null);
    setEditingComment(false);
  }, [src, id]);

  // Persistent highlights stored in node data.
  const highlights: PdfHighlight[] = useMemo(
    () =>
      Array.isArray(data.highlights) ? (data.highlights as PdfHighlight[]) : [],
    [data.highlights],
  );
  const highlightsRef = useRef(highlights);
  highlightsRef.current = highlights;
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const openHighlight = useCallback(
    (highlight: PdfHighlight, position: { x: number; y: number }) => {
      const page = scrollContainerRef.current?.querySelector<HTMLElement>(
        `[data-pdf-page-index="${highlight.pageIndex}"]`,
      );
      if (!page) return;
      const text = readPdfHighlightText(page, highlight);
      if (!text)
        toast(t('messages.commentSelectionUnavailable'), { tone: 'warning' });
      setPendingTextSelection({
        text,
        highlightId: highlight.id,
        rects: new Map([[highlight.pageIndex, highlight.rects]]),
        position,
      });
    },
    [t],
  );
  usePreviewScrollMemory(
    scrollContainerRef,
    embedded ? undefined : scrollViewKey,
  );
  const zoom = usePdfZoom({
    containerRef: scrollContainerRef,
    source: src,
    viewKey: scrollViewKey,
    embedded,
    naturalWidth: naturalPageWidth,
    aspectRatio: pageAspectRatios.get(0) ?? DEFAULT_PDF_PAGE_ASPECT_RATIO,
  });
  const { pageWidth, renderedWidth, scaleFactor } = zoom;

  useEffect(() => {
    const viewport = scrollContainerRef.current;
    if (!embedded || !interactive || !viewport) return;
    viewport.addEventListener('wheel', containNoteWheel, {
      capture: true,
      passive: true,
    });
    return () => viewport.removeEventListener('wheel', containNoteWheel, true);
  }, [embedded, interactive]);

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

  // Dismiss the floating drag handle on scroll
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || !pendingCapture) return;
    const handleScroll = () => setPendingCapture(null);
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [pendingCapture]);

  // ---------------------------------------------------------------------------
  // Native text selection and persisted-highlight activation.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (embedded || captureMode) {
      setPendingTextSelection(null);
      return;
    }
    const el = scrollContainerRef.current;
    if (!el) return;
    let selectionFrame: number | undefined;

    const handleMouseUp = (e: MouseEvent) => {
      if (
        e.target instanceof Element &&
        e.target.closest('[data-pdf-text-drag]')
      )
        return;
      // Small delay lets the browser finalise the selection range.
      if (selectionFrame !== undefined) cancelAnimationFrame(selectionFrame);
      selectionFrame = requestAnimationFrame(() => {
        selectionFrame = undefined;
        const selection = readPdfSelection(el, window.getSelection());
        if (selection) {
          setPendingTextSelection(selection);
          return;
        }
        const page = (
          e.target instanceof Element ? e.target : null
        )?.closest<HTMLElement>('[data-pdf-page-index]');
        if (!page) return;
        const bounds = page.getBoundingClientRect();
        const x = (e.clientX - bounds.left) / bounds.width;
        const y = (e.clientY - bounds.top) / bounds.height;
        const highlight = highlightsRef.current.find(
          (item) =>
            item.pageIndex === Number(page.dataset.pdfPageIndex) &&
            item.rects.some(
              (r) =>
                x >= r.x &&
                x <= r.x + r.width &&
                y >= r.y &&
                y <= r.y + r.height,
            ),
        );
        if (!highlight) return;
        openHighlight(highlight, { x: e.clientX, y: e.clientY });
      });
    };
    const handleKeyUp = () => {
      const selection = readPdfSelection(el, window.getSelection());
      if (selection) setPendingTextSelection(selection);
    };

    el.addEventListener('mouseup', handleMouseUp);
    el.addEventListener('keyup', handleKeyUp);
    return () => {
      el.removeEventListener('mouseup', handleMouseUp);
      el.removeEventListener('keyup', handleKeyUp);
      if (selectionFrame !== undefined) cancelAnimationFrame(selectionFrame);
    };
  }, [embedded, captureMode, openHighlight, src, id]);

  // Dismiss selection actions when selection is cleared or on scroll.
  useEffect(() => {
    if (!pendingTextSelection || editingComment) return;

    const handleSelectionChange = () => {
      if (document.activeElement?.closest('[data-floating-chrome]')) return;
      const text = window.getSelection()?.toString().trim();
      if (!text && !pendingTextSelection.highlightId)
        setPendingTextSelection(null);
    };
    document.addEventListener('selectionchange', handleSelectionChange);

    const el = scrollContainerRef.current;
    const handleScroll = () => setPendingTextSelection(null);
    el?.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      el?.removeEventListener('scroll', handleScroll);
    };
  }, [pendingTextSelection, editingComment]);

  const applyTextHighlight = useCallback(() => {
    if (!pendingTextSelection || !onDataChange) return;
    const updated = pendingTextSelection.highlightId
      ? highlightsRef.current.filter(
          (item) => item.id !== pendingTextSelection.highlightId,
        )
      : computeHighlightUpdate(
          highlightsRef.current,
          pendingTextSelection.rects,
          'add',
        );
    onDataChange({ highlights: updated });
    setPendingTextSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [onDataChange, pendingTextSelection]);

  const handlePageAspectRatioResolved = useCallback(
    (pageIndex: number, aspectRatio: number, naturalWidth?: number) => {
      if (pageIndex === 0 && naturalWidth) setNaturalPageWidth(naturalWidth);
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
    !embedded &&
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

  const getSearchMatchRange = useCallback(
    (matchIndex: number): Range | null => {
      const match = searchMatches[matchIndex];
      if (!match) return null;
      const page = textIndex.pages.get(match.pageIndex);
      const shell = scrollContainerRef.current?.querySelector<HTMLElement>(
        `[data-pdf-page-shell="${match.pageIndex}"]`,
      );
      return page && shell
        ? findProjectedRange(
            shell.querySelector<HTMLElement>('.textLayer') ?? shell,
            page.text,
            match.start,
            match.end,
          )
        : null;
    },
    [searchMatches, textIndex.pages],
  );

  const navigateToSearchMatch = useCallback(
    (
      matchIndex: number,
      onResult: (visible: boolean, range?: Range) => void,
    ) => {
      const match = searchMatches[matchIndex];
      const root = scrollContainerRef.current;
      if (!match || !root) {
        onResult(false);
        return;
      }

      searchNavigationCancelRef.current?.();
      setForcedPageIndex(match.pageIndex);
      const pageShell = root.querySelector<HTMLElement>(
        `[data-pdf-page-shell="${match.pageIndex}"]`,
      );
      pageShell?.scrollIntoView({ block: 'center', behavior: 'auto' });
      searchNavigationCancelRef.current = scheduleScrollToMatch(
        () =>
          root.querySelector<HTMLElement>(
            `[data-pdf-page-shell="${match.pageIndex}"]`,
          ),
        searchQuery.trim(),
        match.pageOccurrenceIndex,
        {
          fallbackToFirst: false,
          getMatchRange: () => getSearchMatchRange(matchIndex),
          onMatch: (range) => onResult(true, range),
          onTimeout: () => onResult(false),
        },
      );
      return searchNavigationCancelRef.current;
    },
    [searchMatches, searchQuery, getSearchMatchRange],
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
            query: searchQuery,
            matchCount: searchMatches.length,
            isSearching:
              !loadError && !!src && (!docLoaded || textIndex.isIndexing),
            canNavigate: !loadError && docLoaded && !textIndex.isIndexing,
            failed: loadError || !src,
            navigateToMatch: navigateToSearchMatch,
            getMatchRange: getSearchMatchRange,
            resolveSourceMatch: async (
              source: Parameters<
                NonNullable<PreviewSearchAdapter['resolveSourceMatch']>
              >[0],
            ) => {
              const markdown =
                typeof data.content === 'string' ? data.content : '';
              if (
                !markdown ||
                (await hashSearchSource(markdown)) !== source.hash
              )
                return null;
              return findPdfSourceMatch(
                textIndex.pages.values(),
                searchQuery.trim(),
                markdown,
                source.offset,
                source.length,
              );
            },
          }
        : null,
    [
      isPdfSearchActive,
      searchQuery,
      navigateToSearchMatch,
      getSearchMatchRange,
      searchMatches.length,
      textIndex.isIndexing,
      docLoaded,
      loadError,
      src,
      data.content,
      textIndex.pages,
    ],
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
          await pageLifecycle.run('importing', async () => {
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
          });
        } catch (error) {
          console.error('[pdf] Could not capture area:', error);
          toast(error instanceof Error ? error.message : String(error), {
            tone: 'danger',
          });
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
    async (attachment: ChatAttachment) => {
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
            conversationViewForNode(node, canvasId)?.conversationOwner
              .threadId ?? undefined
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

      try {
        await pageLifecycle.run('updating', async () => {
          let fallbackThreadId = chat.threadMap[canvasId];
          if (!fallbackThreadId) {
            const binding = await loadDefaultAgentBinding();
            if (
              useCanvasStore.getState().canvasId !== canvasId ||
              usePreviewWorkspaceStore.getState().workspace !==
                preview.workspace
            )
              return;
            fallbackThreadId = chat.ensureCanvasThread(canvasId, binding);
          }
          const pdfTab = findTabByTarget(preview.workspace, pdfTarget);
          const pdfGroup = pdfTab
            ? groupOfTab(preview.workspace, pdfTab.id)
            : null;
          chat.addPendingAttachment(fallbackThreadId, attachment);
          preview.openPreviewTarget(
            { kind: 'chat', canvasId, threadId: fallbackThreadId },
            { groupId: pdfGroup?.id, openToSide: true },
          );
          usePanelStore.getState().requestFocusChatInput(fallbackThreadId);
        });
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), {
          tone: 'danger',
        });
      }
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
  // we portal zoom / capture controls into the shared header
  // (same pattern as NotePreview / WebPreview / OfficePreview) so they
  // sit next to the universal Split view / Close buttons instead of
  // floating over the PDF content. In surfaces that don't provide a
  // slot (e.g. the canvas node form), `el` is null and the toolbar
  // simply isn't rendered.
  const { el: headerSlotEl } = usePreviewHeaderSlot();
  const headerActions = (
    <>
      <PDFZoomControls zoom={zoom} disabled={!docLoaded} />
      <div
        aria-hidden="true"
        className="bg-edge-default mx-1 h-4 w-px shrink-0"
      />
      <PreviewHeaderButton
        title={t('node.selectArea')}
        aria-label={t('node.selectAreaToCapture')}
        aria-pressed={captureMode}
        className={clsx(captureMode && 'text-info-fg bg-bg-default')}
        onClick={() => {
          const next = !captureMode;
          setCaptureMode(next);
          if (!next) setPendingCapture(null);
        }}
      >
        <Scan />
      </PreviewHeaderButton>
    </>
  );

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Event boundary only; the labelled scroll viewport below owns focus and native interaction.
    <div
      className={clsx(
        'relative flex h-full min-h-0 flex-col',
        embedded &&
          (interactive ? 'nodrag nopan' : 'pointer-events-none select-none'),
      )}
      data-pdf-reader={embedded ? 'embedded' : 'preview'}
      data-keyboard-interactive={embedded && interactive ? '' : undefined}
      inert={embedded && !interactive}
      onKeyDown={
        embedded && interactive ? handleCanvasNavigationKey : undefined
      }
      onDoubleClick={
        embedded && interactive ? (event) => event.stopPropagation() : undefined
      }
    >
      {!embedded && <RegisterPDFSearch adapter={searchAdapter} />}
      {!embedded && headerSlotEl
        ? createPortal(headerActions, headerSlotEl)
        : null}
      {/* Loading overlay — visible until document metadata is parsed */}
      {src && !docLoaded && !loadError && (
        <Loading layout="overlay" variant="skeleton" />
      )}
      {/* ── PDF pages ── */}
      <div
        ref={scrollContainerRef}
        data-pdf-scroll-viewport
        onDragStart={(event) => {
          if (embedded || captureMode || !id) return;
          const selection = readPdfSelection(
            event.currentTarget,
            window.getSelection(),
          );
          if (!selection) return;
          setDragPayload(event, {
            kind: 'note',
            origin: { type: 'user-excerpt', excerptFromNodeId: id },
            data: { content: selection.text },
          });
          event.dataTransfer.setData('text/plain', selection.text);
          setPendingTextSelection(null);
        }}
        onDragEnd={() => setPendingTextSelection(null)}
        role={embedded ? 'region' : undefined}
        aria-label={
          embedded ? String(data.label || t('node.untitledPdf')) : undefined
        }
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The selected document viewport supports native keyboard scrolling.
        tabIndex={embedded && interactive ? 0 : undefined}
        className={clsx(
          'bg-surface min-h-0 flex-1 overflow-x-auto overflow-y-auto p-1',
          !embedded && 'pl-8',
          embedded && interactive && 'overscroll-contain',
        )}
      >
        {src ? (
          <div
            style={{
              width: pageWidth > 0 ? pageWidth : undefined,
              minWidth: '100%',
            }}
          >
            <Document
              key={loadAttempt}
              file={resolvedSrc}
              options={PDF_DOCUMENT_OPTIONS}
              onLoadSuccess={onDocumentLoadSuccess}
              onLoadError={() => setFailedSource(src)}
              onSourceError={() => setFailedSource(src)}
              loading=""
              error={
                <div className="text-danger-fg p-4 text-xs">
                  {t('node.errorLoadingPdf')}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFailedSource(null);
                      setLoadAttempt((attempt) => attempt + 1);
                    }}
                  >
                    {t('messages.retry')}
                  </Button>
                </div>
              }
              className={clsx('flex flex-col items-center gap-0')}
            >
              {Array.from(new Array(numPages ?? 0), (_el, index) => (
                <div
                  key={`page_${index + 1}`}
                  data-pdf-page-shell={index}
                  className={clsx(
                    'bg-bg-default shrink-0',
                    embedded && 'overflow-hidden',
                  )}
                  style={{
                    width: pageWidth > 0 ? pageWidth : '100%',
                    aspectRatio:
                      pageAspectRatios.get(index) ??
                      pageAspectRatios.get(0) ??
                      DEFAULT_PDF_PAGE_ASPECT_RATIO,
                  }}
                >
                  {visiblePageIndexes.has(index) ||
                  retainedPageIndexes.has(index) ||
                  forcedPageIndex === index ? (
                    <div
                      style={{
                        width: renderedWidth > 0 ? renderedWidth : undefined,
                        transformOrigin: 'top left',
                        transform: `scale(${scaleFactor})`,
                      }}
                    >
                      <PDFPageWithOverlay
                        pageNumber={index + 1}
                        pageIndex={index}
                        pageWidth={
                          renderedWidth > 0 ? renderedWidth : undefined
                        }
                        captureEnabled={!embedded && captureMode}
                        onAreaCaptured={handleAreaCaptured}
                        persistedRect={
                          pendingCapture && pendingCapture.pageIndex === index
                            ? pendingCapture.captureRect
                            : undefined
                        }
                        highlights={highlights.filter(
                          (h) => h.pageIndex === index,
                        )}
                        textSelection={
                          !embedded &&
                          !captureMode &&
                          !editingComment &&
                          id &&
                          pendingTextSelection &&
                          !pendingTextSelection.highlightId &&
                          !pendingCapture
                            ? {
                                text: pendingTextSelection.text,
                                rects:
                                  pendingTextSelection.rects.get(index) ?? [],
                                excerptFromNodeId: id,
                              }
                            : undefined
                        }
                        selectionScale={scaleFactor}
                        onHighlightActivate={
                          !embedded && !captureMode ? openHighlight : undefined
                        }
                        onAspectRatioResolved={handlePageAspectRatioResolved}
                      />
                    </div>
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
      {!embedded && pendingCapture && (
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

      {/* ── Native text selection actions */}
      {!embedded && id && pendingTextSelection && !pendingCapture && (
        <TextSelectionToolbar
          canvasId={canvasId}
          boundary={scrollContainerRef.current}
          position={pendingTextSelection.position}
          quote={{
            quote: pendingTextSelection.text,
            contextBefore: '',
            contextAfter: '',
            source: {
              kind: 'pdf',
              canvasId,
              nodeId: id,
              pages: [...pendingTextSelection.rects.keys()].map(
                (index) => index + 1,
              ),
            },
          }}
          onEditingChange={setEditingComment}
          onDismiss={() => {
            setEditingComment(false);
            setPendingTextSelection(null);
          }}
        >
          <Button
            variant="ghost"
            iconOnly
            size="sm"
            title={t(
              pendingTextSelection.highlightId
                ? 'messages.removeHighlight'
                : 'node.highlightText',
            )}
            disabled={!onDataChange}
            onClick={applyTextHighlight}
          >
            {pendingTextSelection.highlightId ? <Trash2 /> : <Highlighter />}
          </Button>
        </TextSelectionToolbar>
      )}
    </div>
  );
};
