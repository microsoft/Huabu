import {
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

import { resolveSurface, resolveAccent } from '@sediment/shared';
import {
  createAbsolutePositionGetter,
  indexById,
  type NestableNode,
} from '@sediment/shared/canvas-engine';

import { cn } from '@/components/Common/cn.ts';
import { Spinner } from '@/components/Common/Spinner.tsx';
import { Tooltip } from '@/components/Common/Tooltip.tsx';
import { NodeFloatingToolbar } from '@/components/Panels/Canvas/FloatingToolbars/NodeFloatingToolbar.tsx';
import {
  beginSnapSession,
  endSnapSession,
  applyResizeProposal,
  getResizeContext,
  getResizeSnappedRect,
} from '@/handler/snap/snapSession.ts';
import { useIsNotMouse } from '@/hooks/useInputMode.ts';
import { useNodeLOD } from '@/hooks/useNodeLOD.ts';
import useCanvasStore from '@/store/canvasStore.ts';
import { coerceProvenance } from '@/utils/blockProvenance';

import { getAccentTokens } from './accentTokens.ts';
import {
  NodeConnectionHandles,
  NodeSideAffordance,
  useCreateConnectedNode,
} from './NodeConnectAffordance.tsx';
import { SemanticPlaceholder } from './SemanticPlaceholder.tsx';

import type { CanvasNodeType, NodeData } from './types.ts';

const NODE_BG_OPACITY_PCT = 100;

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
  actions?: React.ReactNode;
  overlayContent?: React.ReactNode;
  /** Vertical offset in screen pixels from the node's top edge. Negative = above. */
  overlayOffsetY?: number;

  keepAspectRatio?: boolean;
  resizable?: boolean;
  borderColor?: string;

  onResizeStart?: () => void;
  onResize?: (width: number, height: number) => void;
  onResizeEnd?: (width: number, height: number) => void;
  onDoubleClick?: React.MouseEventHandler<HTMLDivElement>;
  resizeEndClearHeight?: boolean;
}

// Reference-memoized count of selected nodes. Every NodeWrapper needs to
// know whether it is the *sole* selected node (to show its own resize
// handles / floating toolbar vs. deferring to the multi-select bounding
// box). Filtering `nodes` inside each node's selector made this O(n) per
// node — 25 nodes × scanning 25 nodes on every store update. Since all
// selectors run during the same store notification and share the same
// immutable `nodes` array reference, we scan once per unique array and
// hand every node the cached scalar (25×O(n) → 1×O(n)).
let selectedCountNodesRef: readonly { selected?: boolean }[] | null = null;
let selectedCountCache = 0;
function selectSelectedCount(nodes: readonly { selected?: boolean }[]): number {
  if (nodes !== selectedCountNodesRef) {
    selectedCountNodesRef = nodes;
    let count = 0;
    for (const node of nodes) if (node.selected) count++;
    selectedCountCache = count;
  }
  return selectedCountCache;
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
    actions,
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
    resizeEndClearHeight = false,
  }: NodeWrapperProps) => {
    const selectedCount = useCanvasStore((state) =>
      selectSelectedCount(state.nodes),
    );

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

    const [hovered, setHovered] = useState(false);
    const [editing, setEditing] = useState(false);

    const handleCreateConnected = useCreateConnectedNode(id);

    const renderMode = useNodeLOD(id, type);
    const isNotMouse = useIsNotMouse();

    // Read canvas-space dimensions for SemanticPlaceholder text fitting
    const nodeWidth = useStore((s) => {
      const node = s.nodeLookup.get(id);
      return (node?.style?.width as number) || node?.measured?.width || 400;
    });
    const nodeHeight = useStore((s) => {
      const node = s.nodeLookup.get(id);
      return (node?.style?.height as number) || node?.measured?.height || 200;
    });

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
        onNodeResizeStart();

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
      [id, onNodeResizeStart, onResizeStart],
    );

    const handleResizeEnd = useCallback(
      (
        _event: unknown,
        params: { x: number; y: number; width: number; height: number },
      ) => {
        endResizePreview();
        const snapped = getResizeSnappedRect();
        const ctx = getResizeContext();
        const finalSize = snapped
          ? { width: snapped.size.width, height: snapped.size.height }
          : { width: params.width, height: params.height };
        const finalLocalPos = snapped?.local ?? { x: params.x, y: params.y };

        const positionChanged =
          !!ctx &&
          (finalLocalPos.x !== ctx.startLocalPos.x ||
            finalLocalPos.y !== ctx.startLocalPos.y);
        setNodeGeometry([
          {
            nodeId: id,
            size: resizeEndClearHeight
              ? { width: finalSize.width, height: undefined }
              : finalSize,
            position: positionChanged ? finalLocalPos : undefined,
          },
        ]);
        endSnapSession();
        onResizeEnd?.(finalSize.width, finalSize.height);
      },
      [
        endResizePreview,
        setNodeGeometry,
        id,
        onResizeEnd,
        resizeEndClearHeight,
      ],
    );

    const isMinimal = renderMode === 'minimal';

    // Per-node resize handles are only ever shown when this is the *sole*
    // selected node (multi-selection draws a single bounding-box resizer
    // via `MultiSelectResizer` instead). Mounting `<NodeResizer>` only
    // when that holds — rather than keeping it permanently mounted and
    // toggling `isVisible` — keeps it off the first paint for every
    // unselected node on a freshly loaded canvas. Selecting a node already
    // re-renders this component, so the handles still mount in the same
    // commit as the selection highlight (no perceptible delay).
    const showResizer =
      selected && resizable && !data.locked && selectedCount === 1;

    // Derive accent-tinted tokens once so border/shadow stay in sync with
    // the rest of the canvas (PreviewCard, SemanticPlaceholder, ...).
    // Stored value is a palette token (or legacy hex); resolve to CSS color.
    const accent = resolveAccent(data.style?.accent);
    const accentTokens = accent ? getAccentTokens(accent) : null;

    return (
      <>
        {showResizer && (
          <NodeResizer
            color="var(--color-info-light)"
            minWidth={minWidth}
            minHeight={minHeight}
            keepAspectRatio={keepAspectRatio}
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
        )}
        {selected && selectedCount === 1 && (
          <NodeFloatingToolbar
            id={id}
            type={type}
            data={data}
            toolbar={toolbar}
            actions={actions}
          />
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
            'group relative flex h-full w-full flex-col rounded-lg transition-all duration-120',

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
                : 'ring-edge-default hover:ring',

            type !== 'sketch' && 'border-3 border-transparent',
            // Question nodes need visible overflow for status badges and progress bar
            type === 'question' && 'overflow-visible',
            className,
          )}
          style={{
            ...(() => {
              const bg = resolveSurface(data.style?.backgroundColor);
              if (!bg || bg === 'transparent') return {};

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
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
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

              hasFixedNodeHeight ? 'min-h-0 flex-1' : 'min-h-0',
              isMinimal && 'invisible',

              allowOverflow ? 'overflow-visible' : 'overflow-hidden rounded-md',
            )}
          >
            {children}
          </div>

          <NodeConnectionHandles
            hovered={hovered}
            selected={!!selected}
            isNotMouse={isNotMouse}
          />
        </div>

        <NodeSideAffordance
          nodeId={id}
          selected={!!selected && selectedCount === 1}
          editing={editing}
          onCreate={handleCreateConnected}
        />
      </>
    );
  },
);
