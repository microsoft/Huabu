import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { type Node, type NodeProps, useStore } from '@xyflow/react';
import clsx from 'clsx';
import { ChevronsDown, Fullscreen, MoveVertical } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { applySharedStyles } from '@/components/BlockNote/shadowStyleCache.ts';
import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { useNodeScale } from '@/hooks/useNodeScale';
import useCanvasStore from '@/store/canvasStore';

import { loadBlockNoteContent } from '../../BlockNote/blockNoteContent';
import { NodeWrapper } from '../NodeWrapper';

import type { CanvasNoteNodeData } from '../types';

export type NoteNodeType = Node<CanvasNoteNodeData, 'note'>;

/**
 * Minimum visible height (px) for a note in auto-height mode. Applied on
 * the outer container so the node has a stable size from the very first
 * paint — without this, a brand-new note would briefly render at the
 * shadow host's intrinsic min-height and then visibly collapse to its
 * measured (small) content height once `ResizeObserver` fires.
 */
const AUTO_HEIGHT_MIN = 50;

/**
 * Default height (px) used when the user toggles a previously auto-sized
 * note into fixed-height mode and we have no rendered measurement to seed
 * from. The user can resize via NodeResizer afterwards.
 */
const DEFAULT_FIXED_HEIGHT = 400;

/**
 * Upper bound (px) when seeding the fixed height from the current rendered
 * content height — prevents toggling a very long note into fixed mode from
 * creating a gigantic node on the canvas.
 */
const MAX_SEED_FIXED_HEIGHT = 800;

export const NoteNode = memo(
  ({ id, data, selected }: NodeProps<NoteNodeType>) => {
    const openExpanded = useCanvasStore((s) => s.openExpanded);
    const setNodeGeometry = useCanvasStore((s) => s.setNodeGeometry);
    const patchNodeSilent = useCanvasStore((s) => s.patchNodeSilent);
    const scale = useNodeScale(id, 'note');
    const viewportZoom = useStore((s) => s.transform[2]);
    const counterZoomScale = Math.min(3, Math.max(1, 1 / viewportZoom));
    const hasFixedHeight = useStore(
      (s) =>
        (s.nodeLookup.get(id)?.style?.height as number | undefined) !==
        undefined,
    );
    // Width is required by SET_NODE_GEOMETRY when toggling height modes.
    const styleWidth = useStore(
      (s) => s.nodeLookup.get(id)?.style?.width as number | undefined,
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
    // collapse to `AUTO_HEIGHT_MIN` while waiting for BlockNote to mount
    // and the ResizeObserver to fire (visible flicker during virtualized
    // remounts, zoom changes, and page reloads).
    const seededHeight =
      typeof data.measuredHeight === 'number' && data.measuredHeight > 0
        ? data.measuredHeight
        : 0;
    const [contentHeight, setContentHeight] = useState(seededHeight);
    const [hostHeight, setHostHeight] = useState(0);

    // Read the current explicit height (if any) so we can remember it as
    // "the last fixed height" — used to restore on auto → fixed toggles.
    const styleHeight = useStore(
      (s) => s.nodeLookup.get(id)?.style?.height as number | undefined,
    );
    const lastFixedHeightRef = useRef<number | undefined>(styleHeight);
    useEffect(() => {
      // Only remember real fixed heights — never overwrite with `undefined`
      // (which would erase the memory the moment the user goes to auto).
      if (typeof styleHeight === 'number') {
        lastFixedHeightRef.current = styleHeight;
      }
    }, [styleHeight]);

    const editor = useCreateBlockNote({
      initialContent: [{ type: 'paragraph', content: '' }],
      trailingBlock: false,
    });

    // Toggle between fixed and auto height. Both the toolbar button and
    // the corner "show all content" affordance call into this — they are
    // semantically the same operation.
    //
    // Auto → fixed restores the most recent fixed height when known, so
    // collapsing after a "show all content" click brings the node back to
    // exactly the size it had before. Falls back to the current rendered
    // (capped) measurement, then a default, when no memory is available.
    const handleToggleAutoHeight = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        if (typeof styleWidth !== 'number') return;
        if (hasFixedHeight) {
          // Fixed → auto: clear the explicit height. The current value has
          // already been captured into lastFixedHeightRef by the effect
          // above, so we can restore it on the way back.
          setNodeGeometry([
            { nodeId: id, size: { width: styleWidth, height: undefined } },
          ]);
        } else {
          const remembered = lastFixedHeightRef.current;
          const measured = shadowHostRef.current?.clientHeight ?? 0;
          const seed =
            typeof remembered === 'number' && remembered > 0
              ? remembered
              : measured > 0
                ? Math.min(measured, MAX_SEED_FIXED_HEIGHT)
                : DEFAULT_FIXED_HEIGHT;
          setNodeGeometry([
            { nodeId: id, size: { width: styleWidth, height: seed } },
          ]);
        }
      },
      [hasFixedHeight, id, setNodeGeometry, styleWidth],
    );

    const NoteToolbar = (
      <FloatingToolbar.Group>
        <FloatingToolbar.ToggleButton
          active={!hasFixedHeight}
          title={
            hasFixedHeight ? 'Switch to auto height' : 'Switch to fixed height'
          }
          onClick={handleToggleAutoHeight}
        >
          <MoveVertical />
        </FloatingToolbar.ToggleButton>
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
    // first-frame collapse to `AUTO_HEIGHT_MIN`.
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

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'note'}
        selected={selected}
        toolbar={NoteToolbar}
        keepAspectRatio={false}
      >
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
                  minHeight: AUTO_HEIGHT_MIN,
                  height:
                    contentHeight > 0
                      ? Math.max(contentHeight, AUTO_HEIGHT_MIN) * scale
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
      </NodeWrapper>
    );
  },
);
