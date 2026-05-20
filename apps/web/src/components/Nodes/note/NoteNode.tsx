import { type Node, type NodeProps, useStore } from '@xyflow/react';
import clsx from 'clsx';
import { ChevronsDown, Fullscreen } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { MilkdownPreview } from '@/components/Milkdown';
import { useNodeScale } from '@/hooks/useNodeScale';
import useCanvasStore from '@/store/canvasStore';

import { MissingFileBanner } from '../MissingFileBanner';
import { NodeWrapper } from '../NodeWrapper';
import { NOTE_AUTO_HEIGHT_MIN } from './autoHeight';
import { useTrackNoteFixedHeight } from './heightMemory';

import type { CanvasNoteNodeData } from '../types';

export type NoteNodeType = Node<CanvasNoteNodeData, 'note'>;

export const NoteNode = memo(
  ({ id, data, selected }: NodeProps<NoteNodeType>) => {
    const openExpanded = useCanvasStore((s) => s.openExpanded);
    const setNoteHeightMode = useCanvasStore((s) => s.setNoteHeightMode);
    const patchNodeSilent = useCanvasStore((s) => s.patchNodeSilent);
    const scale = useNodeScale(id, 'note');
    const viewportZoom = useStore((s) => s.transform[2]);
    const counterZoomScale = Math.min(3, Math.max(1, 1 / viewportZoom));
    const hasFixedHeight = useStore(
      (s) =>
        (s.nodeLookup.get(id)?.style?.height as number | undefined) !==
        undefined,
    );

    // `MilkdownPreview` provides its own Shadow DOM via the `isolate`
    // default — the wrapper here only needs to host the height
    // measurement infrastructure and the fixed/auto layout shell. We
    // keep a ref to the wrapper so the ResizeObserver / MutationObserver
    // pair below can re-attach when Milkdown (re)mounts its content.
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

    const NoteToolbar = (
      <FloatingToolbar.Group>
        <FloatingToolbar.ActionButton
          title="Expand"
          onClick={(e) => {
            e.stopPropagation();
            openExpanded(id);
          }}
        >
          <Fullscreen />
        </FloatingToolbar.ActionButton>
      </FloatingToolbar.Group>
    );

    const markdown = typeof data.content === 'string' ? data.content : '';

    // Track the rendered content height. Used only to decide whether to
    // surface the truncation indicator in fixed-height mode.
    //
    // Subtlety: in fixed-height mode the host carries `h-full`, so its
    // own layout box never grows when content overflows — a
    // ResizeObserver on the host alone would never fire on content
    // changes. We additionally observe the host's first child (the
    // shadow-host div that `MilkdownPreview` mounts into) and use a
    // MutationObserver to (re)attach the observer when that child
    // appears or is replaced. `scrollHeight` reads through the Shadow
    // DOM boundary, so we still get the intrinsic content height
    // regardless of the encapsulation.
    useEffect(() => {
      const host = previewHostRef.current;
      if (!host) return;

      const measure = () => {
        const contentH = host.scrollHeight;
        const hostH = host.clientHeight;
        if (contentH > 0) setContentHeight(contentH);
        setHostHeight(hostH);
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
    }, []);

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
        toolbar={isContentMissing ? undefined : NoteToolbar}
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
                  user actually types. `MilkdownPreview` owns its own
                  Shadow DOM (via the default `isolate`), which keeps
                  the Crepe + KaTeX stylesheet stack from leaking into
                  the surrounding page (and vice-versa) without us
                  having to thread `applySharedStyles` through manually.
                */}
                <div
                  ref={previewHostRef}
                  className={clsx(
                    'bg-surface rounded p-2',
                    hasFixedHeight ? 'flex h-full flex-col' : 'flex flex-col',
                  )}
                >
                  <MilkdownPreview
                    markdown={markdown}
                    className="pointer-events-none w-full select-none"
                  />
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
