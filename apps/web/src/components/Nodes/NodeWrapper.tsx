import {
  Handle,
  Position,
  NodeResizer,
  NodeToolbar,
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
import {
  FloatingToolbar,
  FLOATING_TOOLBAR_CLASS,
} from '@/components/Common/FloatingToolbar.tsx';
import { Spinner } from '@/components/Common/Spinner.tsx';
import { Tooltip } from '@/components/Common/Tooltip.tsx';
import { COLOR_PALETTE } from '@/config/colors.ts';
import { NODE_ICON } from '@/config/nodeIcons.ts';
import { useCornerZoomResize } from '@/hooks/useCornerZoomResize.ts';
import { useNodeLOD } from '@/hooks/useNodeLOD.ts';
import useCanvasStore from '@/store/canvasStore.ts';
import { summarizeProvenance } from '@/utils/provenance.ts';

import { SemanticPlaceholder } from './SemanticPlaceholder.tsx';

import type { CanvasNodeType, NodeData } from './types.ts';
import type { BlockProvenanceMap } from '@sediment/shared';

/** Sentinel value representing "no accent". */
const ACCENT_NONE = 'transparent';

/** Accent palette: the shared color palette with a leading "None" entry. */
const ACCENT_PALETTE = [{ name: 'None', value: ACCENT_NONE }, ...COLOR_PALETTE];

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

    onResizeStart,
    onResize: onResizeProp,
    onResizeEnd,
    onDoubleClick,
  }: NodeWrapperProps) => {
    const selectedCount = useCanvasStore(
      (state) => state.nodes.filter((node) => node.selected).length,
    );
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const { tryStartZoom, shouldResize } = useCornerZoomResize();

    const setNodeGeometry = useCanvasStore((state) => state.setNodeGeometry);
    const onNodeResizeStart = useCanvasStore(
      (state) => state.onNodeResizeStart,
    );
    const updateResizePreview = useCanvasStore(
      (state) => state.updateResizePreview,
    );
    const clearFrameFitPreview = useCanvasStore(
      (state) => state.clearFrameFitPreview,
    );
    const ingestion = useCanvasStore((state) => state.ingestionByNodeId[id]);
    const showIngestionOverlay =
      type !== 'frame' && ingestion?.status === 'pending';

    const renderMode = useNodeLOD(id, type);

    // Zoom-invariant handle style – same approach as NodeResizer internals:
    // CSS `scale` property with Math.max(1/zoom, 1) so handles never shrink
    // below their base size but grow when zoomed out.
    const handleScale = useStore((s) => `${Math.max(1 / s.transform[2], 1)}`);
    const handleStyle: React.CSSProperties = useMemo(
      () => ({ scale: handleScale }),
      [handleScale],
    );

    // Read canvas-space dimensions for SemanticPlaceholder text fitting
    const nodeWidth = useStore((s) => {
      const node = s.nodeLookup.get(id);
      return (node?.style?.width as number) || node?.measured?.width || 400;
    });
    const nodeHeight = useStore((s) => {
      const node = s.nodeLookup.get(id);
      return (node?.style?.height as number) || node?.measured?.height || 200;
    });

    // Check if this node was generated by AI
    const isAIGenerated = data.origin?.type?.startsWith('ai-');

    // Compute provenance summary for note nodes
    const provenance =
      'provenance' in data
        ? (data.provenance as BlockProvenanceMap)
        : undefined;
    const provenanceSummary = useMemo(() => {
      if (!provenance) return null;
      const summary = summarizeProvenance(provenance);
      if (summary.total === 0) return null;
      return summary;
    }, [provenance]);

    const handleResize = useCallback(
      (_event: unknown, params: { width: number; height: number }) => {
        // Apply dimensions immediately for visual feedback during drag.
        // This keeps the NodeToolbar and zoom-invariant overlay in sync.
        useCanvasStore.setState((state) => ({
          nodes: state.nodes.map((n) =>
            n.id === id
              ? {
                  ...n,
                  style: {
                    ...n.style,
                    width: params.width,
                    height: params.height,
                  },
                }
              : n,
          ),
        }));
        // Update the frame fit preview so the dashed overlay reflects the
        // new child size while the resize handle is being dragged.
        updateResizePreview(id);
        onResizeProp?.(params.width, params.height);
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
        onResizeStart?.();
      },
      [tryStartZoom, onNodeResizeStart, onResizeStart],
    );

    const handleResizeEnd = useCallback(
      (_event: unknown, params: { width: number; height: number }) => {
        // Clear the preview before dispatching so the overlay disappears as
        // the frame animates to its final fitted size.
        clearFrameFitPreview();
        setNodeGeometry([
          { nodeId: id, size: { width: params.width, height: params.height } },
        ]);
        onResizeEnd?.(params.width, params.height);
      },
      [clearFrameFitPreview, setNodeGeometry, id, onResizeEnd],
    );

    const isMinimal = renderMode === 'minimal';

    return (
      <>
        <NodeResizer
          color="var(--color-info-light)"
          isVisible={selected && resizable && !data.locked}
          minWidth={minWidth}
          minHeight={minHeight}
          keepAspectRatio={keepAspectRatio}
          shouldResize={shouldResize}
          onResizeStart={handleResizeStart}
          onResize={handleResize}
          onResizeEnd={handleResizeEnd}
          handleStyle={{
            width: 8,
            height: 8,
            borderRadius: 0,
          }}
          lineStyle={{
            borderWidth: 8,
          }}
          lineClassName="!border-transparent"
        />
        {toolbar && (
          <NodeToolbar
            isVisible={selected && selectedCount === 1}
            position={Position.Top}
            offset={12}
            className={FLOATING_TOOLBAR_CLASS}
          >
            {/* Node type indicator icon */}
            {(() => {
              const TypeIcon = NODE_ICON[type];
              return (
                <Tooltip content={type}>
                  <div className="text-fg-subtle flex items-center px-1">
                    <TypeIcon size={14} />
                  </div>
                </Tooltip>
              );
            })()}
            <div className="bg-border mx-0.5 h-4 w-px" />
            {toolbar}
            <FloatingToolbar.Divider />
            <FloatingToolbar.ColorPicker
              colors={ACCENT_PALETTE}
              value={data.style?.accent ?? ACCENT_NONE}
              onSelect={(v) =>
                updateNodeData(id, {
                  style: {
                    ...data.style,
                    accent: v === ACCENT_NONE ? null : v,
                  },
                })
              }
              title="Accent Color"
            />
          </NodeToolbar>
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
            type !== 'text' && !data.style?.accent && 'shadow',
            'style' in data && data.style?.backgroundColor
              ? data.style.backgroundColor
              : 'bg-transparent',
            selected ? 'ring-info ring' : 'ring-border hover:ring',
            // Accent: colored border + bottom-right shadow
            data.style?.accent && 'border-2',
            className,
          )}
          style={
            data.style?.accent
              ? {
                  borderColor:
                    type === 'frame'
                      ? `color-mix(in srgb, var(--color-fg-default) 0%, transparent)`
                      : `${data.style.accent}80`,
                  ...(type === 'frame' && {
                    boxShadow: `4px 4px 3px 3px ${data.style.accent}`,
                  }),
                }
              : undefined
          }
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
                  ? `AI: ${provenanceSummary.aiCount} blocks, User: ${provenanceSummary.userCount}, Mixed: ${provenanceSummary.mixedCount}`
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
              'flex-1 p-0',
              isMinimal && 'invisible',
              allowOverflow ? 'overflow-visible' : 'overflow-hidden',
            )}
          >
            {children}
          </div>

          <Handle
            type="target"
            id="top-target"
            position={Position.Top}
            style={handleStyle}
            className="bg-info! -top-1! h-1! w-1! border-none! opacity-0 transition-opacity group-hover:opacity-100"
          />
          <Handle
            type="source"
            id="top-source"
            position={Position.Top}
            style={handleStyle}
            className="bg-info! -top-1! h-1! w-1! border-none! opacity-0 transition-opacity group-hover:opacity-100"
          />
          <Handle
            type="target"
            id="right-target"
            position={Position.Right}
            style={handleStyle}
            className="bg-info! -right-1! h-1! w-1! border-none! opacity-0 transition-opacity group-hover:opacity-100"
          />
          <Handle
            type="source"
            id="right-source"
            position={Position.Right}
            style={handleStyle}
            className="bg-info! -right-1! h-1! w-1! border-none! opacity-0 transition-opacity group-hover:opacity-100"
          />
          <Handle
            type="target"
            id="bottom-target"
            position={Position.Bottom}
            style={handleStyle}
            className="bg-info! -bottom-1! h-1! w-1! border-none! opacity-0 transition-opacity group-hover:opacity-100"
          />
          <Handle
            type="source"
            id="bottom-source"
            position={Position.Bottom}
            style={handleStyle}
            className="bg-info! -bottom-1! h-1! w-1! border-none! opacity-0 transition-opacity group-hover:opacity-100"
          />
          <Handle
            type="target"
            id="left-target"
            position={Position.Left}
            style={handleStyle}
            className="bg-info! -left-1! h-1! w-1! border-none! opacity-0 transition-opacity group-hover:opacity-100"
          />
          <Handle
            type="source"
            id="left-source"
            position={Position.Left}
            style={handleStyle}
            className="bg-info! -left-1! h-1! w-1! border-none! opacity-0 transition-opacity group-hover:opacity-100"
          />
        </div>
      </>
    );
  },
);
