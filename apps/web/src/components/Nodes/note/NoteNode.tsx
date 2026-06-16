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

import { MissingFileBanner } from '../MissingFileBanner';
import { NodeWrapper } from '../NodeWrapper';
import { NOTE_AUTO_HEIGHT_MIN } from './autoHeight';
import { useTrackNoteFixedHeight } from './heightMemory';
import { requestNoteHydration } from './noteHydrationScheduler';

import type { CanvasNoteNodeData } from '../types';

export type NoteNodeType = Node<CanvasNoteNodeData, 'note'>;

export const NoteNode = memo(
  ({ id, data, selected }: NodeProps<NoteNodeType>) => {
    const openExpanded = useCanvasStore((s) => s.openExpanded);
    const setNoteHeightMode = useCanvasStore((s) => s.setNoteHeightMode);
    const patchNodeSilent = useCanvasStore((s) => s.patchNodeSilent);
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
    // scheduler we render a lightweight spinner placeholder (the same
    // `Spinner` the PDF node shows while loading), sized by the persisted
    // `measuredHeight` seed so the node keeps its real footprint. The
    // upgrade to the real editor is visually identical — only the timing
    // of the build work changes. See `noteHydrationScheduler`.
    const [hydrated, setHydrated] = useState(false);
    useEffect(() => {
      // Skip while the node is a semantic-zoom placeholder; it re-runs and
      // registers once the node zooms into full LOD. Once hydrated we keep
      // the editor mounted (never tear down) so zooming back out and in
      // again doesn't re-pay the build cost.
      if (hydrated || isMinimalLOD) return;
      const cancel = requestNoteHydration(() => setHydrated(true));
      return cancel;
    }, [hydrated, isMinimalLOD]);

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

    // When the picked accent is `white`, the wrapper's default border —
    // a 50%-transparent mix of white over `transparent` — is effectively
    // invisible. Force a solid white border instead so the swatch and the
    // rendered border match exactly.
    const borderColorOverride =
      data.style?.accent === 'white' ? '#ffffff' : undefined;

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'note'}
        selected={selected}
        actions={isContentMissing ? undefined : NoteActions}
        keepAspectRatio={false}
        borderColor={borderColorOverride}
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
                'bg-surface relative w-full',
                hasFixedHeight && 'h-full overflow-hidden',
              )}
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
                    'bg-surface rounded p-2',
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
