import { resolveSurface, resolveAccent } from '@sediment/shared';
import {
  Handle,
  Position,
  NodeResizer,
  useInternalNode,
  useViewport,
  useStore,
} from '@xyflow/react';
import clsx from 'clsx';
import React, {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/components/Common/cn.ts';
import { Spinner } from '@/components/Common/Spinner.tsx';
import { Tooltip } from '@/components/Common/Tooltip.tsx';
import { NodeFloatingToolbar } from '@/components/Panels/Canvas/FloatingToolbars/NodeFloatingToolbar.tsx';
import {
  createAbsolutePositionGetter,
  indexById,
  type NestableNode,
} from '@/handler/canvasCommand/utils/frame';
import {
  beginSnapSession,
  endSnapSession,
  applyResizeProposal,
  getResizeContext,
  getResizeSnappedRect,
} from '@/handler/snap/snapSession.ts';
import { useCornerZoomResize } from '@/hooks/useCornerZoomResize.ts';
import { useIsNotMouse } from '@/hooks/useInputMode.ts';
import { useNodeLOD } from '@/hooks/useNodeLOD.ts';
import useCanvasStore from '@/store/canvasStore.ts';
import { coerceProvenance } from '@/utils/blockProvenance';

import { getAccentTokens } from './accentTokens.ts';
import { SemanticPlaceholder } from './SemanticPlaceholder.tsx';

import type { CanvasNodeType, NodeData } from './types.ts';

/**
 * Global node background opacity, in percent. The wrapper composites every
 * resolved `backgroundColor` against `transparent` at this percentage so the
 * canvas grid faintly shows through every node — making overlapping cards
 * read more like layered translucent paper than fully opaque tiles.
 *
 * Centralised here so the same value applies to every node type
 * (SURFACE_PALETTE tints, accent-derived `color-mix(...)` fills, and
 * one-off `var(...)` backgrounds like QuestionNode's).
 */
const NODE_BG_OPACITY_PCT = 100;

/** Connection handle definitions – source + target on each side. */
const HANDLE_DEFS = [
  {
    type: 'target' as const,
    id: 'top-target',
    position: Position.Top,
  },
  {
    type: 'source' as const,
    id: 'top-source',
    position: Position.Top,
  },
  {
    type: 'target' as const,
    id: 'right-target',
    position: Position.Right,
  },
  {
    type: 'source' as const,
    id: 'right-source',
    position: Position.Right,
  },
  {
    type: 'target' as const,
    id: 'bottom-target',
    position: Position.Bottom,
  },
  {
    type: 'source' as const,
    id: 'bottom-source',
    position: Position.Bottom,
  },
  {
    type: 'target' as const,
    id: 'left-target',
    position: Position.Left,
  },
  {
    type: 'source' as const,
    id: 'left-source',
    position: Position.Left,
  },
] as const;

/**
 * Isolated component that subscribes to viewport changes for the
 * zoom-invariant overlay portal. This prevents the entire NodeWrapper
 * from re-rendering on every pan/zoom event.
 *
 * Uses the FLIP technique to animate position changes in sync with the
 * node's CSS transform transition:
 *  1. Set left/top to the final (new) position immediately — always correct
 *     for pan/zoom.
 *  2. Invert via `transform: translate(-Δx, -Δy)` so the overlay visually
 *     appears at the OLD position without a transition.
 *  3. Play: in the next animation frame, reset transform to (0,0) with a
 *     CSS transition that matches the node animation duration.
 */
const OverlayPortal = memo(
  ({
    nodeId,
    offsetY,
    children,
  }: {
    nodeId: string;
    offsetY: number;
    children: React.ReactNode;
  }) => {
    const domNode = useStore((state) => state.domNode);
    const rendererEl = useMemo(
      () => domNode?.querySelector('.react-flow__renderer') ?? null,
      [domNode],
    );
    const internalNode = useInternalNode(nodeId);
    const { zoom, x: vpX, y: vpY } = useViewport();

    const absX = internalNode?.internals.positionAbsolute?.x ?? 0;
    const absY = internalNode?.internals.positionAbsolute?.y ?? 0;

    // left/top always equal the final screen position so the label stays
    // correct during pan/zoom without any extra logic.
    const left = absX * zoom + vpX;
    const top = absY * zoom + vpY + offsetY;

    // FLIP state: a transient transform offset that starts at -Δ and
    // transitions back to (0,0), giving the illusion of smooth movement.
    const prevAbsRef = useRef({ x: absX, y: absY });
    const [flipOffset, setFlipOffset] = useState({ x: 0, y: 0 });
    const [playing, setPlaying] = useState(false);
    const rafRef = useRef(0);

    useLayoutEffect(() => {
      if (!internalNode) return;

      const dx = absX - prevAbsRef.current.x;
      const dy = absY - prevAbsRef.current.y;
      if (dx === 0 && dy === 0) return; // pan/zoom only — no position change

      prevAbsRef.current = { x: absX, y: absY };

      // Only animate when the node itself has a transition active.
      const nodeStyle = internalNode.style as
        | Record<string, unknown>
        | undefined;
      if (typeof nodeStyle?.transition !== 'string') return;

      // Invert: visually keep label at old position (no transition yet).
      setFlipOffset({ x: -dx * zoom, y: -dy * zoom });
      setPlaying(false);

      // Play: next frame — transition transform back to (0,0).
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        setFlipOffset({ x: 0, y: 0 });
        setPlaying(true);
      });

      return () => cancelAnimationFrame(rafRef.current);
    }, [absX, absY, zoom]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!rendererEl || !internalNode?.internals.positionAbsolute) return null;

    return createPortal(
      <div
        style={{
          position: 'absolute',
          zIndex: 1000,
          left,
          top,
          pointerEvents: 'auto',
          transform: `translate(${flipOffset.x}px, ${flipOffset.y}px)`,
          transition: playing
            ? 'transform 350ms cubic-bezier(0.4, 0, 0.2, 1)'
            : undefined,
        }}
      >
        {children}
      </div>,
      rendererEl,
    );
  },
);
OverlayPortal.displayName = 'OverlayPortal';

interface NodeWrapperProps {
  id: string;
  data: NodeData;
  type: CanvasNodeType;
  selected?: boolean;

  allowOverflow?: boolean;

  children: React.ReactNode;
  className?: string;
  minWidth?: number;
  minHeight?: number;
  toolbar?: React.ReactNode;

  /**
   * Content to render in the zoom-invariant overlay layer.
   * Positioned at the node's top-left corner in screen space.
   * Use `overlayOffsetY` (screen px) to shift vertically (negative = above the node).
   */
  overlayContent?: React.ReactNode;
  /** Vertical offset in screen pixels from the node's top edge. Negative = above. */
  overlayOffsetY?: number;

  keepAspectRatio?: boolean;
  resizable?: boolean;

  /**
   * Optional override for the outer accent border color. When provided,
   * this wins over the auto-derived `accentTokens.border` (which is a
   * 50%-transparent mix of the accent over `transparent`). Useful for
   * accents like `white` where the default mix is effectively invisible
   * and a node wants the border to match the swatch exactly.
   */
  borderColor?: string;

  onResizeStart?: () => void;
  onResize?: (width: number, height: number) => void;
  onResizeEnd?: (width: number, height: number) => void;
  onDoubleClick?: React.MouseEventHandler<HTMLDivElement>;
}

export const NodeWrapper = memo(
  ({
    id,
    type,
    data,
    selected,
    children,
    className,
    minWidth,
    minHeight,
    toolbar,
    overlayContent,
    overlayOffsetY = 0,
    keepAspectRatio = false,
    resizable = true,

    allowOverflow = false,

    borderColor,

    onResizeStart,
    onResize: onResizeProp,
    onResizeEnd,
    onDoubleClick,
  }: NodeWrapperProps) => {
    const selectedCount = useCanvasStore(
      (state) => state.nodes.filter((node) => node.selected).length,
    );
    const { tryStartZoom, shouldResize } = useCornerZoomResize();

    const setNodeGeometry = useCanvasStore((state) => state.setNodeGeometry);
    const onNodeResizeStart = useCanvasStore(
      (state) => state.onNodeResizeStart,
    );
    const updateResizePreview = useCanvasStore(
      (state) => state.updateResizePreview,
    );
    const endResizePreview = useCanvasStore((state) => state.endResizePreview);
    const ingestion = useCanvasStore((state) => state.ingestionByNodeId[id]);
    const showIngestionOverlay =
      type !== 'frame' && ingestion?.status === 'pending';

    const renderMode = useNodeLOD(id, type);
    const isNotMouse = useIsNotMouse();

    // Zoom-invariant handle style: scale up width/height directly so React
    // Flow's getBoundingClientRect-based edge routing stays centred on the
    // handle.  React Flow's default `transform: translate(-50%, -50%)`
    // already centres handles at any size, so no margin compensation is
    // needed.
    const baseHandleSize = isNotMouse ? 10 : 4;
    const handleStyle: React.CSSProperties = useStore((s) => {
      const factor = Math.max(1 / s.transform[2], 1);
      const size = baseHandleSize * factor;
      return {
        width: size,
        height: size,
      };
    });

    // Read canvas-space dimensions for SemanticPlaceholder text fitting
    const nodeWidth = useStore((s) => {
      const node = s.nodeLookup.get(id);
      return (node?.style?.width as number) || node?.measured?.width || 400;
    });
    const nodeHeight = useStore((s) => {
      const node = s.nodeLookup.get(id);
      return (node?.style?.height as number) || node?.measured?.height || 200;
    });
    // Whether the node has an explicit pinned height. When false the parent
    // RF node element is content-sized, so the children area must NOT use
    // `flex-1 + min-h-0` (which would collapse to 0 in an auto-height flex
    // column) — it should size to its content instead.
    const hasFixedNodeHeight = useStore(
      (s) =>
        (s.nodeLookup.get(id)?.style?.height as number | undefined) !==
        undefined,
    );

    // Check if this node was generated by AI
    const isAIGenerated = data.origin?.type?.startsWith('ai-');

    // Compute provenance summary for note nodes (Phase 4 shape).
    const provenanceSummary = useMemo(() => {
      if (!('provenance' in data)) return null;
      const prov = coerceProvenance(
        (data as { provenance?: unknown }).provenance,
      );
      const total = prov.blocks.length + prov.deletedBlocks.length;
      if (total === 0) return null;
      return {
        editedCount: prov.blocks.length,
        deletedCount: prov.deletedBlocks.length,
      };
    }, [data]);

    // Smart-snap during resize is fully delegated to `snapSession`:
    //   • `handleResizeStart` captures the start rect and opens a
    //     resize session — all gesture state lives there, not in
    //     refs on this component.
    //   • `handleResize` forwards RF's raw proposal to
    //     `applyResizeProposal`, which derives `activeEdges`, runs
    //     the snap engine, caches the snapped local rect, and returns
    //     it. We immediately forward the snapped width/height to the
    //     optional `onResize` listener so child auto-fit logic (e.g.
    //     text font-size) gets the snapped values with no frame lag.
    //   • The store write happens once in `canvasStore.onNodesChange`
    //     via `applySnap`, which reads the cached snapped rect and
    //     rewrites RF's emitted dim/pos NodeChanges. The same
    //     reducer then mirrors the (possibly snapped) live dim/pos
    //     values onto `node.style.{width,height}` + `position` so
    //     the rendered DOM tracks the drag — `applyChange` itself
    //     only writes `node.measured`, which RF does not read for
    //     inline sizing. This component no longer issues its own
    //     `setState` for resize: a single `applyNodeChanges`-based
    //     write per frame is the only writer, which keeps the
    //     autosave middleware happy and avoids the double-render the
    //     previous inline write produced.
    //   • `handleResizeEnd` reads the cached snapped rect via
    //     `getResizeSnappedRect` to commit the final geometry through
    //     the undoable `setNodeGeometry` intent.

    const handleResize = useCallback(
      (
        _event: unknown,
        params: { x: number; y: number; width: number; height: number },
      ) => {
        const zoom = useCanvasStore.getState().rfInstance?.getZoom() ?? 1;
        const snapped = applyResizeProposal(params, zoom);
        // Keep the frame-fit overlay aligned with the live resize.
        updateResizePreview(id);
        onResizeProp?.(snapped.width, snapped.height);
      },
      [id, onResizeProp, updateResizePreview],
    );

    const handleResizeStart = useCallback(
      (
        event: unknown,
        params: { x: number; y: number; width: number; height: number },
      ) => {
        if (tryStartZoom(event, params)) return;
        onNodeResizeStart();

        // Capture pre-resize bounds in absolute flow-space so the
        // snap engine can derive `activeEdges` by diffing each
        // frame's proposal against this baseline (RF's `direction`
        // field on `OnResize` describes growth sign, not which edge
        // is moving — derivation by diff is the cleanest source of
        // truth). The capture lives inside snapSession for the
        // duration of the gesture.
        const state = useCanvasStore.getState();
        const nodes = state.nodes as NestableNode[];
        const byId = indexById(nodes);
        const getAbs = createAbsolutePositionGetter(byId);
        const self = byId.get(id);
        const parentOffset = { x: 0, y: 0 };
        if (self?.parentId) {
          const pa = getAbs(self.parentId);
          if (pa) {
            parentOffset.x = pa.x;
            parentOffset.y = pa.y;
          }
        }

        const altPressed =
          (event as { altKey?: boolean } | undefined)?.altKey ?? false;
        beginSnapSession({
          nodes,
          gestureIds: new Set([id]),
          altPressed,
          kind: 'resize',
          resizeContext: {
            nodeId: id,
            startRect: {
              x: parentOffset.x + params.x,
              y: parentOffset.y + params.y,
              w: params.width,
              h: params.height,
            },
            startLocalPos: { x: params.x, y: params.y },
            parentOffset,
          },
        });

        onResizeStart?.();
      },
      [id, tryStartZoom, onNodeResizeStart, onResizeStart],
    );

    const handleResizeEnd = useCallback(
      (
        _event: unknown,
        params: { x: number; y: number; width: number; height: number },
      ) => {
        // Clear the preview before dispatching so the overlay disappears as
        // the frame animates to its final fitted size. `endResizePreview`
        // also cancels any pending rAF inside `updateResizePreview` —
        // otherwise a queued fit-pass scheduled milliseconds before
        // mouseup could fire *after* `setNodeGeometry` lands and
        // redraw the overlay against the pre-commit geometry.
        endResizePreview();
        // Prefer the snapped rect cached by `applyResizeProposal` over
        // RF's raw `params` (which are the cursor-derived pre-snap
        // numbers). Fall back to `params` if no proposal was processed
        // (e.g. handle clicked and released without movement, or the
        // resize session was disabled at gesture start due to mixed
        // parents — neither case touches `_lastResizeSnapped`).
        const snapped = getResizeSnappedRect();
        const ctx = getResizeContext();
        const finalSize = snapped
          ? { width: snapped.size.width, height: snapped.size.height }
          : { width: params.width, height: params.height };
        const finalLocalPos = snapped?.local ?? { x: params.x, y: params.y };
        // Skip the position update when snap (and RF) left the
        // top-left corner exactly where it started — otherwise we'd
        // create a no-op undo entry on every plain right/bottom-only
        // resize. Comparison is in local space against the captured
        // start position.
        const positionChanged =
          !!ctx &&
          (finalLocalPos.x !== ctx.startLocalPos.x ||
            finalLocalPos.y !== ctx.startLocalPos.y);
        setNodeGeometry([
          {
            nodeId: id,
            size: finalSize,
            position: positionChanged ? finalLocalPos : undefined,
          },
        ]);
        endSnapSession();
        onResizeEnd?.(finalSize.width, finalSize.height);
      },
      [endResizePreview, setNodeGeometry, id, onResizeEnd],
    );

    const isMinimal = renderMode === 'minimal';

    // Derive accent-tinted tokens once so border/shadow stay in sync with
    // the rest of the canvas (PreviewCard, SemanticPlaceholder, ...).
    // Stored value is a palette token (or legacy hex); resolve to CSS color.
    const accent = resolveAccent(data.style?.accent);
    const accentTokens = accent ? getAccentTokens(accent) : null;

    return (
      <>
        <NodeResizer
          color="var(--color-info-light)"
          // Per-node handles only when this is the sole selected node.
          // For multi-selection, a single set of handles is rendered on
          // the selection bounding box by `MultiSelectResizer` instead.
          isVisible={
            selected && resizable && !data.locked && selectedCount === 1
          }
          minWidth={minWidth}
          minHeight={minHeight}
          keepAspectRatio={keepAspectRatio}
          shouldResize={shouldResize}
          onResizeStart={handleResizeStart}
          onResize={handleResize}
          onResizeEnd={handleResizeEnd}
          handleStyle={{
            width: isNotMouse ? 12 : 8,
            height: isNotMouse ? 12 : 8,
            borderRadius: 0,
          }}
          lineClassName="!border-transparent"
        />
        {toolbar && selected && selectedCount === 1 && (
          <NodeFloatingToolbar id={id} type={type} data={data}>
            {toolbar}
          </NodeFloatingToolbar>
        )}

        {/* Zoom-invariant overlay portal — isolated component to avoid re-rendering the entire NodeWrapper on pan/zoom */}
        {overlayContent && (
          <OverlayPortal nodeId={id} offsetY={overlayOffsetY}>
            {overlayContent}
          </OverlayPortal>
        )}

        {/* Semantic zoom: placeholder overlay when in minimal LOD */}
        {isMinimal && (
          <SemanticPlaceholder
            type={type}
            data={data}
            width={nodeWidth}
            height={nodeHeight}
          />
        )}

        <div
          className={cn(
            'group relative flex h-full w-full flex-col rounded transition-all duration-120',
            // Drop shadow whenever there is no *visible* colored accent.
            // A `white` accent is visually neutral (its 50%-mix border is
            // effectively invisible against the canvas), so it should keep
            // the same soft edge as "no accent".
            type !== 'text' &&
              type !== 'sketch' &&
              type !== 'question' &&
              (!data.style?.accent || data.style.accent === 'white') &&
              'shadow',
            !data.style?.backgroundColor && 'bg-transparent',
            selected
              ? type === 'sketch'
                ? 'ring-info/50 ring'
                : 'ring-info ring'
              : type === 'sketch'
                ? ''
                : 'ring-border hover:ring',
            // Always reserve a 3px border so toggling accent on/off does
            // not shift inner content. Default border is transparent;
            // accent (or other states) override `borderColor` via style.
            // Sketch nodes have no accent picker and no visible border, so
            // skip the reservation — otherwise the 3px inset shrinks the
            // SVG viewBox area vs the on-overlay preview, making the
            // committed stroke jump and shrink at pointer-up.
            type !== 'sketch' && 'border-3 border-transparent',
            // Question nodes need visible overflow for status badges and progress bar
            type === 'question' && 'overflow-visible',
            className,
          )}
          style={{
            ...(() => {
              const bg = resolveSurface(data.style?.backgroundColor);
              if (!bg || bg === 'transparent') return {};
              // Composite every node background against transparent so the
              // canvas grid faintly shows through. `color-mix` accepts any
              // valid CSS color (hex, keyword, nested color-mix, var(...)),
              // so this works uniformly across SURFACE_PALETTE tints,
              // accent-derived fills (FrameNode / TextNode), and one-off
              // var(...) colors (QuestionNode).
              return {
                backgroundColor: `color-mix(in srgb, ${bg} ${NODE_BG_OPACITY_PCT}%, transparent)`,
              };
            })(),
            ...(accentTokens && {
              borderColor: accentTokens.border,
            }),
            ...(type === 'question' && {
              borderColor: 'transparent',
            }),
            // Node-level override (e.g. NoteNode forces solid white when
            // the picked accent is `white`). Applied last so it always wins.
            ...(borderColor && { borderColor }),
          }}
          onDoubleClick={onDoubleClick}
        >
          {showIngestionOverlay && (
            <div className="pointer-events-none absolute right-1.5 bottom-1.5 z-10">
              <Spinner size="xs" className="text-fg-subtle" />
            </div>
          )}

          {/* AI provenance badge */}
          {isAIGenerated && (
            <Tooltip
              content={
                provenanceSummary
                  ? `AI edits pending: ${provenanceSummary.editedCount}, deletions: ${provenanceSummary.deletedCount}`
                  : 'AI generated'
              }
            >
              <div
                className={clsx(
                  'absolute top-1 right-1 z-10 flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] leading-none font-medium',
                  'bg-ai-bg text-ai',
                )}
              >
                <span>AI</span>
              </div>
            </Tooltip>
          )}

          <div
            className={clsx(
              'p-0',
              // In fixed-height mode fill the remaining flex track; in
              // auto-height mode size to content so the chain can grow with
              // the children (e.g. Note's BlockNote content). `min-h-0` is
              // fine while filling but would collapse the auto chain to 0.
              hasFixedNodeHeight ? 'min-h-0 flex-1' : 'min-h-0',
              isMinimal && 'invisible',
              allowOverflow ? 'overflow-visible' : 'overflow-hidden',
            )}
          >
            {children}
          </div>

          {HANDLE_DEFS.map((h) => (
            <Handle
              key={h.id}
              type={h.type}
              id={h.id}
              position={h.position}
              style={handleStyle}
              className={cn(
                'bg-info! z-20 border-none! transition-opacity',
                isNotMouse
                  ? cn(
                      selected
                        ? 'opacity-40 active:opacity-100'
                        : 'pointer-events-none opacity-0',
                    )
                  : cn('opacity-0 group-hover:opacity-100'),
              )}
            />
          ))}
        </div>
      </>
    );
  },
);
