import { type Node, type NodeProps, useStore } from '@xyflow/react';
import clsx from 'clsx';
import { ChevronsDown, Fullscreen } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { SkeletonLines } from '@/components/Common/SkeletonLines';
import { MilkdownPreview } from '@/components/Milkdown';
import { useNodeLOD } from '@/hooks/useNodeLOD';
import { useNodeScale } from '@/hooks/useNodeScale';
import useCanvasStore from '@/store/canvasStore';
import {
  canMoveSedimentPayload,
  canReadSedimentPayload,
  getSedimentPayload,
} from '@/utils/io/dragDrop';
import { dragPayloadToMarkdown } from '@/utils/io/payloadToMarkdown';
import { isMac } from '@/utils/platform';

import { MissingFileBanner } from '../MissingFileBanner';
import { NodeWrapper } from '../NodeWrapper';
import { NOTE_AUTO_HEIGHT_MIN } from './autoHeight';
import { useTrackNoteFixedHeight } from './heightMemory';
import { useDeferredHydration } from '../shared/nodeHydrationScheduler';

import type { CanvasNoteNodeData } from '../types';

export type NoteNodeType = Node<CanvasNoteNodeData, 'note'>;

/**
 * Join an existing note's Markdown with a newly-inserted Markdown
 * snippet, preserving block boundaries. Ensures the new snippet
 * starts on a fresh paragraph:
 *  - empty target → just the snippet (trimmed)
 *  - target ends with a blank line → single `\n` separator
 *  - otherwise → `\n\n` separator
 *
 * Trailing whitespace on the existing content is preserved so the
 * user's intentional spacing isn't clobbered.
 */
function appendMarkdownBlock(existing: string, snippet: string): string {
  const trimmedSnippet = snippet.trim();
  if (trimmedSnippet === '') return existing;
  if (existing === '') return trimmedSnippet;
  // Already ends with a blank-line separator (e.g. "foo\n\n").
  if (/\n\s*\n\s*$/.test(existing)) return existing + trimmedSnippet;
  // Ends with a single newline → add one more to make a blank line.
  if (existing.endsWith('\n')) return existing + '\n' + trimmedSnippet;
  return existing + '\n\n' + trimmedSnippet;
}

export const NoteNode = memo(
  ({ id, data, selected }: NodeProps<NoteNodeType>) => {
    const openExpanded = useCanvasStore((s) => s.openExpanded);
    const setNoteHeightMode = useCanvasStore((s) => s.setNoteHeightMode);
    const patchNodeSilent = useCanvasStore((s) => s.patchNodeSilent);
    const updateNodeData = useCanvasStore((s) => s.updateNodeData);
    const moveNoteBlockIntoNote = useCanvasStore(
      (s) => s.moveNoteBlockIntoNote,
    );
    // Needed to resolve artifact-key image srcs (e.g. `art_xxx.png`)
    // into fetchable HTTP URLs before they're written into the note's
    // markdown — without it the inserted `<img>` would silently fail
    // to load.
    const canvasId = useCanvasStore((s) => s.canvasId);
    const scale = useNodeScale(id, 'note');
    // When the node is zoomed out far enough, `NodeWrapper` hides this
    // content and overlays a cheap `SemanticPlaceholder` instead. There is
    // no point building (or even staggering) a Milkdown editor that the
    // user can't see — gate hydration on the same LOD so a zoomed-out
    // canvas mounts zero editors until a node is actually zoomed in.
    const isMinimalLOD = useNodeLOD(id, 'note') === 'minimal';
    const viewportZoom = useStore((s) => s.transform[2]);
    const counterZoomScale = Math.min(3, Math.max(1, 1 / viewportZoom));
    const hasFixedHeight = useStore(
      (s) =>
        (s.nodeLookup.get(id)?.style?.height as number | undefined) !==
        undefined,
    );

    // The wrapper hosts the height-measurement infrastructure and the
    // fixed/auto layout shell; `MilkdownPreview` mounts the editor
    // directly into it (light DOM). The ResizeObserver / MutationObserver
    // pair below re-attaches when Milkdown (re)mounts its content.
    const previewHostRef = useRef<HTMLDivElement>(null);

    // Latest measured rendered content height & host (visible) height.
    // Both are kept in state so the truncation indicator re-evaluates when
    // either the content grows/shrinks or the user resizes the node.
    //
    // `contentHeight` is seeded from the persisted `data.measuredHeight`
    // hint so an auto-height note paints at its real size on the very
    // first frame after mount — without the seed, the node would briefly
    // collapse to `NOTE_AUTO_HEIGHT_MIN` while waiting for the editor to
    // mount and the ResizeObserver to fire (visible flicker during
    // virtualized remounts, zoom changes, and page reloads).
    const seededHeight =
      typeof data.measuredHeight === 'number' && data.measuredHeight > 0
        ? data.measuredHeight
        : 0;
    const [contentHeight, setContentHeight] = useState(seededHeight);
    const [hostHeight, setHostHeight] = useState(0);

    // Defer the (expensive) Milkdown editor mount so a canvas full of
    // notes doesn't build every Crepe/ProseMirror instance inside one
    // blocking React commit on load. Until granted a turn by the shared
    // scheduler we render a lightweight spinner placeholder, sized by
    // the persisted `measuredHeight` seed so the node keeps its real
    // footprint. The upgrade to the real editor is visually identical —
    // only the timing of the build work changes. The `isMinimalLOD`
    // gate skips the queue entirely while the node is a semantic-zoom
    // placeholder; once zoom crosses back into full LOD the hook
    // re-enqueues. Once hydrated we keep the editor mounted (never tear
    // down) so zooming back out and in again doesn't re-pay the build
    // cost. See `../shared/nodeHydrationScheduler`.
    const hydrated = useDeferredHydration(isMinimalLOD);

    // Session-scoped memory of "last pinned height" for this note. Lets a
    // "fixed → auto → fixed" round-trip restore the previous size instead
    // of snapping to the current rendered measurement. The hook owns the
    // recording side; `setNoteHeightMode` (called by every toggle entry
    // point) reads from the same shared map.
    useTrackNoteFixedHeight(id);

    // Toggle between fixed and auto height. Both the toolbar button and
    // the corner "show all content" affordance call into this — they are
    // semantically the same operation, so they share the store-level
    // `setNoteHeightMode` orchestration (gesture wrap, parent-frame
    // refit, width fallback, remembered-height seed, undo batching).
    const handleToggleAutoHeight = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        setNoteHeightMode([id], hasFixedHeight ? 'auto' : 'fixed');
      },
      [hasFixedHeight, id, setNoteHeightMode],
    );

    const NoteActions = (
      <FloatingToolbar.ActionButton
        title="Expand"
        onClick={(e) => {
          e.stopPropagation();
          openExpanded(id);
        }}
      >
        <Fullscreen />
      </FloatingToolbar.ActionButton>
    );

    const markdown = typeof data.content === 'string' ? data.content : '';

    // Measure `.ProseMirror` (not host.scrollHeight): Crepe's block-edit
    // plugin keeps an absolute-positioned `.milkdown-block-handle` at
    // the bottom of `.milkdown`, which inflates host.scrollHeight by
    // ~34px and leaves dead bg-surface below the text in auto mode.
    // Add host's vertical padding back since `.ProseMirror` doesn't
    // include it. Observation chain covers fixed-mode (host has
    // h-full so its own size never changes) by also watching the
    // first child + MutationObserver for editor (re)mounts.
    useEffect(() => {
      const host = previewHostRef.current;
      if (!host) return;
      // While the spinner placeholder is showing there is no `.ProseMirror`
      // to measure; skip entirely so we never persist the placeholder's
      // height as the note's `measuredHeight`. The seeded `contentHeight`
      // keeps the footprint correct until the real editor mounts.
      if (!hydrated) return;

      const measure = () => {
        const prose = host.querySelector('.ProseMirror') as HTMLElement | null;
        let contentH: number;
        if (prose) {
          const cs = getComputedStyle(host);
          const padY =
            (parseFloat(cs.paddingTop) || 0) +
            (parseFloat(cs.paddingBottom) || 0);
          contentH = prose.scrollHeight + padY;
        } else {
          contentH = host.scrollHeight;
        }
        if (contentH > 0) setContentHeight(contentH);
        setHostHeight(host.clientHeight);
      };

      const ro = new ResizeObserver(measure);
      ro.observe(host);

      // Track the current first child so we only re-observe when it changes.
      let observedChild: Element | null = null;
      const syncChildObservation = () => {
        const child = host.firstElementChild;
        if (child === observedChild) return;
        if (observedChild) ro.unobserve(observedChild);
        observedChild = child;
        if (child) ro.observe(child);
      };

      // Initial attempt + a few rAFs to catch async editor mounting.
      syncChildObservation();
      measure();
      const raf1 = requestAnimationFrame(() => {
        syncChildObservation();
        measure();
      });

      // Watch for the editor (re)rendering its root inside the host.
      const mo = new MutationObserver(() => {
        syncChildObservation();
        measure();
      });
      mo.observe(host, { childList: true, subtree: true });

      return () => {
        cancelAnimationFrame(raf1);
        mo.disconnect();
        ro.disconnect();
      };
    }, [hydrated]);

    // Truncation only matters in fixed-height mode. Both heights are state,
    // so this re-evaluates when the user resizes the node or the content
    // reflows inside the editor.
    const isTruncated =
      hasFixedHeight &&
      contentHeight > 0 &&
      hostHeight > 0 &&
      contentHeight - hostHeight > 1;

    // Persist the measured intrinsic content height back into node data so
    // the next mount (virtualization remount, zoom-triggered re-render,
    // page reload) can seed `contentHeight` immediately and skip the
    // first-frame collapse to `NOTE_AUTO_HEIGHT_MIN`.
    //
    // Silent patch (no undo entry) and gated on a >1px delta to avoid
    // spamming the store with sub-pixel jitter from the ResizeObserver.
    useEffect(() => {
      if (contentHeight <= 0) return;
      const persisted =
        typeof data.measuredHeight === 'number' ? data.measuredHeight : 0;
      if (Math.abs(persisted - contentHeight) <= 1) return;
      patchNodeSilent(id, { measuredHeight: contentHeight });
    }, [contentHeight, data.measuredHeight, id, patchNodeSilent]);

    // Markdown file missing on disk + no in-memory fallback → replace
    // the editor with a full-card placeholder.
    const isContentMissing = data.contentMissing && !markdown.trim();

    // When the user picks an accent the wrapper paints both the border
    // and the accent-tinted fill. Drop the inner paper surfaces in that
    // case so the fill is visible through the note body; otherwise we
    // keep `bg-surface` so the no-accent note still reads as paper.
    const hasAccent = !!data.style?.accent;

    // ── Drop target: accept Sediment payloads (note blocks from
    // chat / other notes, image cards, web cards) and append the
    // payload's Markdown to this note's content. Locked notes opt
    // out so the gesture falls through to canvas's "create new
    // node" handler instead.
    const isLocked = !!data.locked;
    // We use a small counter to track dragenter / dragleave events so
    // hovering between child elements doesn't flicker the highlight.
    const dragCounterRef = useRef(0);
    const [isDropTarget, setIsDropTarget] = useState(false);
    const handleNoteDragEnter = useCallback(
      (e: React.DragEvent) => {
        if (isLocked) return;
        if (!canReadSedimentPayload(e.dataTransfer)) return;
        dragCounterRef.current += 1;
        if (dragCounterRef.current === 1) setIsDropTarget(true);
      },
      [isLocked],
    );
    const handleNoteDragOver = useCallback(
      (e: React.DragEvent) => {
        if (isLocked) return;
        if (!canReadSedimentPayload(e.dataTransfer)) return;
        e.preventDefault();
        // Prevent the canvas-level `onDragOver` from also marking this
        // event as a "create new node" candidate — we are claiming
        // this gesture for "insert into this note".
        e.stopPropagation();
        // Platform-aware copy modifier: macOS uses Option (matches
        // Finder), Windows/Linux uses Ctrl (matches Explorer). Cmd is
        // deliberately NOT honored on macOS — the OS reserves Cmd for
        // a system-level drag operation, and reading it here would
        // conflict with the NSDragOperation and cause `drop` to never
        // fire (the gesture silently aborts).
        const isCopyModifier = isMac ? e.altKey : e.ctrlKey;
        const canMove = canMoveSedimentPayload(e.dataTransfer);
        e.dataTransfer.dropEffect =
          canMove && !isCopyModifier ? 'move' : 'copy';
      },
      [isLocked],
    );
    const handleNoteDragLeave = useCallback(
      (e: React.DragEvent) => {
        if (isLocked) return;
        if (!canReadSedimentPayload(e.dataTransfer)) return;
        dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
        if (dragCounterRef.current === 0) setIsDropTarget(false);
      },
      [isLocked],
    );
    const resetDragState = useCallback(() => {
      dragCounterRef.current = 0;
      setIsDropTarget(false);
    }, []);
    const handleNoteDrop = useCallback(
      (e: React.DragEvent) => {
        if (isLocked) return;
        if (!canReadSedimentPayload(e.dataTransfer)) return;
        const payload = getSedimentPayload(e.dataTransfer);
        if (!payload) {
          resetDragState();
          return;
        }
        // Block dragged from this same note → ignore; let Crepe's
        // own block-handle / canvas-level handler decide. (Dropping
        // a note back onto its own tile is meaningless.)
        if (payload.kind === 'note' && payload.data.sourceNodeId === id) {
          resetDragState();
          return;
        }

        const snippet = dragPayloadToMarkdown(payload, {
          ...(canvasId ? { canvasId } : {}),
        });
        if (!snippet) {
          resetDragState();
          return;
        }

        // Claim the gesture so the canvas's `onDrop` doesn't also fire
        // and create a brand-new note next to us.
        e.preventDefault();
        e.stopPropagation();

        const currentContent =
          typeof data.content === 'string' ? data.content : '';
        const targetContentAfterInsert = appendMarkdownBlock(
          currentContent,
          snippet,
        );

        const isCopyModifier = isMac ? e.altKey : e.ctrlKey;
        const sourceNodeId =
          payload.kind === 'note' ? payload.data.sourceNodeId : undefined;
        const sourceContentAfterMove =
          payload.kind === 'note'
            ? payload.data.sourceContentAfterMove
            : undefined;
        const canMove =
          typeof sourceNodeId === 'string' &&
          typeof sourceContentAfterMove === 'string';

        if (canMove && !isCopyModifier) {
          // Atomic cross-note move: one undo entry covers both source
          // and target updates.
          moveNoteBlockIntoNote({
            sourceNodeId: sourceNodeId as string,
            sourceContentAfterMove: sourceContentAfterMove as string,
            targetNodeId: id,
            targetContentAfterInsert,
          });
        } else {
          // COPY (modifier held) or external source (chat / image /
          // web) → only the target gets a content patch.
          updateNodeData(id, { content: targetContentAfterInsert });
        }

        resetDragState();
      },
      [
        canvasId,
        data.content,
        id,
        isLocked,
        moveNoteBlockIntoNote,
        resetDragState,
        updateNodeData,
      ],
    );

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'note'}
        selected={selected}
        actions={isContentMissing ? undefined : NoteActions}
        keepAspectRatio={false}
        // Active drop-target highlight: thick `--info-light` ring on
        // the wrapper's true outer edge plus a translucent
        // `--info-light` wash over the whole node — same hue family
        // as NotePreview's insertion bar but softer so it reads as a
        // "zone" rather than a precise insertion point.
        className={
          isDropTarget ? 'ring-info-light bg-info-light/60 ring-4' : undefined
        }
      >
        {isContentMissing ? (
          <MissingFileBanner
            nodeId={id}
            title="Note file missing"
            description="The note file for this node was deleted or renamed outside the app."
          />
        ) : (
          <>
            <div
              className={clsx(
                'relative w-full',
                !hasAccent && 'bg-surface',
                hasFixedHeight && 'h-full overflow-hidden',
              )}
              onDragEnter={handleNoteDragEnter}
              onDragOver={handleNoteDragOver}
              onDragLeave={handleNoteDragLeave}
              onDrop={handleNoteDrop}
              // In auto-height mode the inner content is visually scaled via
              // CSS `transform: scale(scale)`, but transforms do NOT affect
              // layout — the parent would only reserve the *unscaled* height
              // and clip the bottom of the (visually larger) content. Reserve
              // the scaled height explicitly so the node grows to fit.
              //
              // We also pin a `minHeight` from the very first paint (even
              // before `contentHeight` has been measured) so the node never
              // visibly collapses from the host's intrinsic min-height down
              // to a smaller measured content height once the
              // ResizeObserver fires.
              style={
                !hasFixedHeight
                  ? {
                      minHeight: NOTE_AUTO_HEIGHT_MIN,
                      height:
                        contentHeight > 0
                          ? Math.max(contentHeight, NOTE_AUTO_HEIGHT_MIN) *
                            scale
                          : undefined,
                    }
                  : undefined
              }
            >
              <div
                style={{
                  transform: `scale(${scale})`,
                  transformOrigin: 'top left',
                  width: `${100 / scale}%`,
                  ...(hasFixedHeight ? { height: `${100 / scale}%` } : {}),
                }}
              >
                {/*
                  This card surface is render-only — the expanded editor
                  opened via the toolbar's Expand button is where the
                  user actually types. `MilkdownPreview` mounts Milkdown
                  in light DOM directly into this wrapper; Crepe +
                  KaTeX styles are already scoped under `.milkdown` (see
                  `milkdown-overrides.css`) so no extra isolation is
                  required.
                */}
                <div
                  ref={previewHostRef}
                  className={clsx(
                    'rounded p-2',
                    !hasAccent && 'bg-surface',
                    hasFixedHeight ? 'flex h-full flex-col' : 'flex flex-col',
                  )}
                >
                  {hydrated ? (
                    <MilkdownPreview
                      markdown={markdown}
                      className="pointer-events-none w-full select-none"
                    />
                  ) : (
                    // Lightweight placeholder while the editor mount is
                    // deferred. Reuses the same `SkeletonLines` shimmer the
                    // PDF node shows while loading.
                    //
                    // Centering target differs by height mode: in fixed
                    // mode the host already constrains to the node's visible
                    // height, so fill it (`h-full`) and center within that
                    // visible range. In auto mode there is no fixed height,
                    // so seed `minHeight` from the persisted content height
                    // to keep the node's footprint and center within it.
                    <div
                      className={clsx(
                        'flex w-full items-center justify-center',
                        hasFixedHeight && 'h-full',
                      )}
                      style={
                        hasFixedHeight
                          ? undefined
                          : {
                              minHeight:
                                seededHeight > 0
                                  ? seededHeight
                                  : NOTE_AUTO_HEIGHT_MIN,
                            }
                      }
                      aria-hidden
                    >
                      {/* No shimmer in minimal LOD — the content is
                          hidden behind the SemanticPlaceholder, so an
                          animated placeholder would just be wasted work. */}
                      {!isMinimalLOD && (
                        <SkeletonLines className="w-full max-w-xs" />
                      )}
                    </div>
                  )}
                </div>
              </div>
              {isTruncated && (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={handleToggleAutoHeight}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      handleToggleAutoHeight(e as unknown as React.MouseEvent);
                    }
                  }}
                  className="group absolute right-0 bottom-0 left-0 flex h-10 cursor-pointer items-end justify-center pb-1"
                  aria-label="Show all content"
                >
                  {/* Fade gradient — deepens on hover */}
                  <div
                    aria-hidden
                    className="from-fg-subtle/30 group-hover:from-fg-muted/30 absolute inset-0 bg-linear-to-t to-transparent transition-colors"
                  />
                  <div
                    className="text-fg-subtle group-hover:text-fg-muted relative z-10 transition-colors"
                    style={{
                      transform: `scale(${counterZoomScale})`,
                      transformOrigin: 'bottom center',
                    }}
                  >
                    <ChevronsDown size={14} />
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </NodeWrapper>
    );
  },
);
