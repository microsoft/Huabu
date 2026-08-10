// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { type Node, type NodeProps, useStore } from '@xyflow/react';
import clsx from 'clsx';
import { ChevronsDown, Fullscreen } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { autoHeightKey } from '@huabu/shared/canvas-engine';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { Loading } from '@/components/Common/Loading';
import { MilkdownPreview } from '@/components/Milkdown';
import { useNodeLOD } from '@/hooks/useNodeLOD';
import { useNodeScale } from '@/hooks/useNodeScale';
import useCanvasStore from '@/store/canvasStore';
import { openPreviewNode } from '@/store/previewWorkspace/actions';
import {
  canMoveHuabuPayload,
  canReadHuabuPayload,
  getHuabuPayload,
} from '@/utils/io/dragDrop';
import { dragPayloadToMarkdown } from '@/utils/io/payloadToMarkdown';
import { isMac } from '@/utils/platform';

import { MissingFileBanner } from '../MissingFileBanner';
import { NodeWrapper } from '../NodeWrapper';
import { useTrackNoteFixedHeight } from './heightMemory';
import {
  NOTE_CONTENT_HOST_CLASS,
  readNoteIntrinsicHeight,
} from './noteContentHost';
import { useAutoHeightInvariant } from './useAutoHeightInvariant';
import {
  cancelMeasuredHeight,
  proposeMeasuredHeight,
} from '../shared/height/commitQueue';
import { useHeightMode } from '../shared/height/useHeightMode';
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
    const { t } = useTranslation();
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
    // Who owns the height — never inferred from whether a number is
    // present, because after the ownership model an auto note carries one
    // too. The body renders identically either way; this only gates the
    // measurement proposal and the observers that feed it.
    const isFixedHeight = useHeightMode(id) === 'fixed';

    // The wrapper hosts the height-measurement infrastructure and the
    // layout shell; `MilkdownPreview` mounts the editor
    // directly into it (light DOM). The ResizeObserver / MutationObserver
    // pair below re-attaches when Milkdown (re)mounts its content.
    const previewHostRef = useRef<HTMLDivElement>(null);

    // Latest measured rendered content height & host (visible) height.
    // Both are kept in state so the truncation indicator re-evaluates when
    // either the content grows/shrinks or the user resizes the node.
    //
    // `contentHeight` is the node's *intrinsic* height: measured at the
    // type's reference width, before the node's own scaling. It no longer
    // sizes anything — it is a proposal, committed through
    // `applyMeasuredHeights` and materialized back into `style.height` by
    // the engine. Starting at 0 is safe precisely because of that: the
    // store already holds a usable height before this component mounts.
    const measurementKey = autoHeightKey({ data } as unknown as Node);
    const [contentMeasurement, setContentMeasurement] = useState<{
      height: number;
      measuredFor: string;
    } | null>(null);
    const contentHeight = contentMeasurement?.height ?? 0;
    const [hostHeight, setHostHeight] = useState(0);

    // Defer the (expensive) Milkdown editor mount so a canvas full of
    // notes doesn't build every Crepe/ProseMirror instance inside one
    // blocking React commit on load. Until granted a turn by the shared
    // scheduler we render a lightweight spinner placeholder. The node
    // keeps its real footprint throughout, because the footprint comes
    // from `style.height` rather than from anything rendered here. The
    // upgrade to the real editor is visually identical —
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

    const NoteActions = (
      <FloatingToolbar.ActionButton
        title={t('node.expand')}
        onClick={(e) => {
          e.stopPropagation();
          openPreviewNode(id);
        }}
      >
        <Fullscreen />
      </FloatingToolbar.ActionButton>
    );

    const markdown = typeof data.content === 'string' ? data.content : '';

    // Measurement is shared with the offscreen measurer via
    // `readNoteIntrinsicHeight`, so the two surfaces cannot answer
    // differently for the same content. The observation chain below is
    // what this surface adds: the host is `h-full`, so its own size never
    // changes with content, and we have to watch the editor's root plus a
    // MutationObserver for (re)mounts.
    useEffect(() => {
      const host = previewHostRef.current;
      if (!host) return;
      // While the spinner placeholder is showing there is no `.ProseMirror`
      // to measure; skip entirely so we never report the placeholder's
      // height as the note's content height. The node keeps the footprint
      // already stored in `style.height` until the real editor mounts.
      if (!hydrated) return;

      const measure = () => {
        const contentH = readNoteIntrinsicHeight(host);
        if (contentH > 0) {
          setContentMeasurement((previous) =>
            previous?.height === contentH &&
            previous.measuredFor === measurementKey
              ? previous
              : { height: contentH, measuredFor: measurementKey },
          );
        }
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
    }, [hydrated, measurementKey]);

    // Truncation is no longer conditional on fixed mode. In auto mode it
    // surfaces the window between "the content grew" and "the correction
    // committed", which is the honest signal: the node really is showing
    // less than it holds right now.
    const isTruncated =
      contentHeight > 0 && hostHeight > 0 && contentHeight - hostHeight > 1;

    // Report the measured intrinsic height as a *proposal*. The queue
    // decides whether it is worth committing and when; the engine owns
    // the conversion to a layout height and the write to `style.height`.
    // Nothing here sizes the node.
    //
    // Only in auto mode. A pinned note renders inside a box the user
    // chose, and a measurement taken there cannot be trusted as the
    // content's intrinsic height — worse, a wrong hint is
    // self-confirming, because materializing it produces exactly the
    // height the next measurement would be compared against.
    // `setNoteHeightMode` measures offscreen instead when it needs one.
    useEffect(() => {
      if (!contentMeasurement) return;
      if (isFixedHeight) return;
      proposeMeasuredHeight({
        nodeId: id,
        intrinsicHeight: contentMeasurement.height,
        measuredFor: contentMeasurement.measuredFor,
      });
    }, [contentMeasurement, id, isFixedHeight]);

    // A pending proposal for an unmounting node describes a measurement
    // nobody is waiting for. Dropping it also keeps a virtualization
    // churn from flushing stale entries after the node is gone.
    useEffect(() => () => cancelMeasuredHeight(id), [id]);

    // Dev-only: an auto note that still does not fit once the commit
    // queue has settled means the measurement disagrees with the layout.
    useAutoHeightInvariant(
      id,
      previewHostRef,
      hydrated && !isFixedHeight,
      contentHeight,
    );

    // A missing sidecar is a write barrier even if stale content remains in
    // memory, so never expose editing or drop targets while it is absent.
    const isContentMissing = data.contentMissing === true;

    // When the user picks an accent the wrapper paints both the border
    // and the accent-tinted fill. Drop the inner paper surfaces in that
    // case so the fill is visible through the note body; otherwise we
    // keep `bg-surface` so the no-accent note still reads as paper.
    const hasAccent = !!data.style?.accent;

    // ── Drop target: accept Huabu payloads (note blocks from
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
        if (!canReadHuabuPayload(e.dataTransfer)) return;
        dragCounterRef.current += 1;
        if (dragCounterRef.current === 1) setIsDropTarget(true);
      },
      [isLocked],
    );
    const handleNoteDragOver = useCallback(
      (e: React.DragEvent) => {
        if (isLocked) return;
        if (!canReadHuabuPayload(e.dataTransfer)) return;
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
        const canMove = canMoveHuabuPayload(e.dataTransfer);
        e.dataTransfer.dropEffect =
          canMove && !isCopyModifier ? 'move' : 'copy';
      },
      [isLocked],
    );
    const handleNoteDragLeave = useCallback(
      (e: React.DragEvent) => {
        if (isLocked) return;
        if (!canReadHuabuPayload(e.dataTransfer)) return;
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
        if (!canReadHuabuPayload(e.dataTransfer)) return;
        const payload = getHuabuPayload(e.dataTransfer);
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

        const snippet = dragPayloadToMarkdown(payload, { canvasId });
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
          <MissingFileBanner nodeId={id} />
        ) : (
          <>
            <div
              className={clsx(
                'relative h-full w-full overflow-hidden',
                !hasAccent && 'bg-surface',
              )}
              onDragEnter={handleNoteDragEnter}
              onDragOver={handleNoteDragOver}
              onDragLeave={handleNoteDragLeave}
              onDrop={handleNoteDrop}
            >
              <div
                style={{
                  transform: `scale(${scale})`,
                  transformOrigin: 'top left',
                  width: `${100 / scale}%`,
                  height: `${100 / scale}%`,
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
                  // Stable hook for the auto-height end-to-end assertion.
                  // The box this marks is the one a measurement is taken
                  // from, so a test that checks "content fits" has to
                  // find exactly it — not a utility class that a restyle
                  // could rename out from under it.
                  data-note-content-host=""
                  className={clsx(
                    NOTE_CONTENT_HOST_CLASS,
                    'h-full',
                    !hasAccent && 'bg-surface',
                  )}
                >
                  {hydrated ? (
                    <MilkdownPreview
                      markdown={markdown}
                      canvasId={canvasId ?? undefined}
                      className="pointer-events-none w-full select-none"
                    />
                  ) : (
                    // Lightweight placeholder while the editor mount is
                    // deferred. The host already constrains to the node's
                    // layout height in both modes, so filling it is enough —
                    // the footprint comes from `style.height`, never from
                    // anything measured here.
                    <div
                      className="flex h-full w-full items-center justify-center"
                      aria-hidden
                    >
                      {/* No shimmer in minimal LOD — the content is
                          hidden behind the SemanticPlaceholder, so an
                          animated placeholder would just be wasted work. */}
                      {!isMinimalLOD && (
                        <Loading
                          variant="skeleton"
                          layout="bare"
                          className="w-full max-w-xs"
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>
              {isTruncated && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute right-0 bottom-0 left-0 flex h-10 items-end justify-center pb-1"
                >
                  {/* Fade gradient */}
                  <div
                    aria-hidden
                    className="from-fg-subtle/30 absolute inset-0 bg-linear-to-t to-transparent"
                  />
                  <div
                    className="text-fg-subtle relative z-10"
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
