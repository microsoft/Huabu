import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { type Node, type NodeProps, useStore } from '@xyflow/react';
import clsx from 'clsx';
import { ChevronsDown, Fullscreen } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { applySharedStyles } from '@/components/BlockNote/shadowStyleCache.ts';
import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { useNodeScale } from '@/hooks/useNodeScale';
import useCanvasStore from '@/store/canvasStore';

import { loadBlockNoteContent } from '../../BlockNote/blockNoteContent';
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

    const shadowHostRef = useRef<HTMLDivElement>(null);
    const shadowRootRef = useRef<ShadowRoot | null>(null);
    const reactRootRef = useRef<Root | null>(null);
    const shadowContainerRef = useRef<HTMLDivElement | null>(null);

    // Latest measured rendered content height & host (visible) height.
    // Both are kept in state so the truncation indicator re-evaluates when
    // either the content grows/shrinks or the user resizes the node.
    //
    // `contentHeight` is seeded from the persisted `data.measuredHeight`
    // hint so an auto-height note paints at its real size on the very
    // first frame after mount — without the seed, the node would briefly
    // collapse to `NOTE_AUTO_HEIGHT_MIN` while waiting for BlockNote to mount
    // and the ResizeObserver to fire (visible flicker during virtualized
    // remounts, zoom changes, and page reloads).
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

    const editor = useCreateBlockNote({
      initialContent: [{ type: 'paragraph', content: '' }],
      trailingBlock: false,
    });

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

    // Initialize Shadow DOM
    useEffect(() => {
      if (!shadowHostRef.current) return;

      // Check if shadow root already exists on the DOM element
      if (shadowHostRef.current.shadowRoot) {
        shadowRootRef.current = shadowHostRef.current.shadowRoot;
        shadowContainerRef.current =
          shadowHostRef.current.shadowRoot.querySelector('div');
        return;
      }

      // Create Shadow DOM
      const shadowRoot = shadowHostRef.current.attachShadow({ mode: 'open' });
      shadowRootRef.current = shadowRoot;

      // Create container for React content
      const container = document.createElement('div');
      container.className = 'flex flex-col rounded bg-surface p-4';
      shadowRoot.appendChild(container);
      shadowContainerRef.current = container;

      // Inject styles into Shadow DOM from shared cache. Same-origin
      // sheets are attached synchronously via `adoptedStyleSheets`, which
      // avoids the FOUC that <link> cloning would otherwise cause on the
      // first paint of a new note (incorrect content height → visible
      // "tall then short" jump).
      applySharedStyles(shadowRoot);

      // Create React root in Shadow DOM
      reactRootRef.current = createRoot(container);

      return () => {
        // Cleanup on unmount
        if (reactRootRef.current) {
          setTimeout(() => {
            reactRootRef.current?.unmount();
          }, 0);
          reactRootRef.current = null;
        }
        shadowRootRef.current = null;
        shadowContainerRef.current = null;
      };
    }, []); // Empty deps - only run once on mount

    // Keep shadow DOM container class in sync with fixed/auto height mode.
    // In fixed mode the container fills the pinned height (so overflow is
    // clipped at the node bounds); in auto mode it sizes to its content.
    useEffect(() => {
      const container = shadowContainerRef.current;
      if (!container) return;
      container.className = hasFixedHeight
        ? 'flex h-full flex-col rounded bg-surface p-2'
        : 'flex flex-col rounded bg-surface p-2';
    }, [hasFixedHeight]);

    // Update Shadow DOM content when editor or data changes
    useEffect(() => {
      if (!reactRootRef.current) return;

      reactRootRef.current.render(
        <BlockNoteView
          className="block-note-view block-note-view-readonly pointer-events-none select-none"
          editor={editor}
          editable={false}
          sideMenu={false}
        />,
      );
    }, [editor]);

    // Update content when data changes.
    // Prefer contentJson (lossless BlockNote JSON) when available and in sync
    // with content (Markdown). Fall back to parsing content as Markdown.
    useEffect(() => {
      const markdown = typeof data.content === 'string' ? data.content : '';
      const contentJson =
        typeof data.contentJson === 'string' ? data.contentJson : null;
      const contentJsonSource =
        typeof data.contentJsonSource === 'string'
          ? data.contentJsonSource
          : null;

      void loadBlockNoteContent(
        editor,
        markdown,
        contentJson,
        contentJsonSource,
      );
    }, [data.content, data.contentJson, data.contentJsonSource, editor]);

    // Track the rendered content height. Used only to decide whether to
    // surface the truncation indicator in fixed-height mode.
    //
    // Subtlety: in fixed-height mode the shadow DOM container has `h-full`,
    // so its own layout box never grows when BlockNote content overflows —
    // a ResizeObserver on the container alone would never fire on content
    // changes. We instead observe the container's first child (the BlockNote
    // root, which has a natural intrinsic height) and use a MutationObserver
    // to (re)attach the observer when that child appears or is replaced.
    useEffect(() => {
      const host = shadowHostRef.current;
      const container = shadowContainerRef.current;
      if (!host || !container) return;

      const measure = () => {
        const contentH = container.scrollHeight;
        const hostH = host.clientHeight;
        if (contentH > 0) setContentHeight(contentH);
        setHostHeight(hostH);
      };

      const ro = new ResizeObserver(measure);
      ro.observe(host);
      ro.observe(container);

      // Track the current first child so we only re-observe when it changes.
      let observedChild: Element | null = null;
      const syncChildObservation = () => {
        const child = container.firstElementChild;
        if (child === observedChild) return;
        if (observedChild) ro.unobserve(observedChild);
        observedChild = child;
        if (child) ro.observe(child);
      };

      // Initial attempt + a few rAFs to catch async BlockNote mounting.
      syncChildObservation();
      measure();
      const raf1 = requestAnimationFrame(() => {
        syncChildObservation();
        measure();
      });

      // Watch for BlockNote (re)rendering its root inside the container.
      const mo = new MutationObserver(() => {
        syncChildObservation();
        measure();
      });
      mo.observe(container, { childList: true, subtree: true });

      return () => {
        cancelAnimationFrame(raf1);
        mo.disconnect();
        ro.disconnect();
      };
    }, []);

    // Truncation only matters in fixed-height mode. Both heights are state,
    // so this re-evaluates when the user resizes the node or the content
    // reflows inside the shadow DOM.
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
    const isContentMissing =
      data.contentMissing &&
      !(typeof data.content === 'string' && data.content.trim());

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
              // visibly collapses from the shadow host's intrinsic min-height
              // down to a smaller measured content height once the
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
                <div
                  ref={shadowHostRef}
                  className={clsx('w-full', hasFixedHeight && 'h-full')}
                />
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
