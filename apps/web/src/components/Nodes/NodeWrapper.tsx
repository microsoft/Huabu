import {
  Handle,
  Position,
  NodeResizer,
  NodeToolbar,
  useInternalNode,
  useViewport,
  useStore,
} from '@xyflow/react';
import { clsx } from 'clsx';
import { GripVertical } from 'lucide-react';
import React, {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import useCanvasStore from '@/store/canvasStore.ts';

import type { CanvasNodeType, NodeData } from './types.ts';

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

    const dispatch = useCanvasStore((state) => state.dispatch);
    const takeSnapshot = useCanvasStore((state) => state.takeSnapshot);
    const updateResizePreview = useCanvasStore(
      (state) => state.updateResizePreview,
    );
    const clearFrameFitPreview = useCanvasStore(
      (state) => state.clearFrameFitPreview,
    );
    const ingestion = useCanvasStore((state) => state.ingestionByNodeId[id]);
    const showIngestionOverlay =
      type !== 'frame' && ingestion?.status === 'pending';

    // Check if this node was generated by research
    const isResearchGenerated = data.origin?.type === 'research';

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

    const handleResizeStart = useCallback(() => {
      // Snapshot the pre-drag state so the entire resize is a single undo entry.
      takeSnapshot();
      onResizeStart?.();
    }, [onResizeStart, takeSnapshot]);

    const handleResizeEnd = useCallback(
      (_event: unknown, params: { width: number; height: number }) => {
        // Clear the preview before dispatching so the overlay disappears as
        // the frame animates to its final fitted size.
        clearFrameFitPreview();
        // Commit the final size through dispatch so the autosave middleware
        // picks it up. The snapshot was already taken in handleResizeStart.
        dispatch({
          type: 'RESIZE_NODE',
          nodeId: id,
          width: params.width,
          height: params.height,
        });
        onResizeEnd?.(params.width, params.height);
      },
      [clearFrameFitPreview, dispatch, id, onResizeEnd],
    );

    return (
      <>
        <NodeResizer
          color="var(--color-theme-300)"
          isVisible={selected && resizable && !data.locked}
          minWidth={
            type === 'pdf' || type === 'note' || type === 'web' ? 120 : minWidth
          }
          minHeight={
            type === 'pdf' || type === 'note' || type === 'web'
              ? 120
              : minHeight
          }
          keepAspectRatio={keepAspectRatio}
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
            className="border-border shadow-bottom flex h-8 items-center gap-3 rounded-md border bg-white px-2 py-1"
          >
            {toolbar}
          </NodeToolbar>
        )}

        {/* Zoom-invariant overlay portal — isolated component to avoid re-rendering the entire NodeWrapper on pan/zoom */}
        {overlayContent && (
          <OverlayPortal nodeId={id} offsetY={overlayOffsetY}>
            {overlayContent}
          </OverlayPortal>
        )}

        <div
          className={clsx(
            'group relative flex h-full w-full flex-col rounded shadow transition-all duration-120',
            'style' in data && data.style?.backgroundColor
              ? data.style.backgroundColor
              : 'bg-transparent',
            selected ? 'ring-theme-500 ring' : 'ring-border hover:ring',
            // Research node visual identifier: left purple border
            isResearchGenerated && 'border-l-4 border-l-purple-500',
            className,
          )}
          onDoubleClick={onDoubleClick}
        >
          {showIngestionOverlay && (
            <div className="pointer-events-none absolute right-1.5 bottom-1.5 z-10">
              <div className="border-muted-foreground/30 border-t-muted-foreground h-3 w-3 animate-spin rounded-full border-2" />
            </div>
          )}

          <div
            className={clsx(
              'text-icon hover:text-main absolute top-0 -left-4.5 flex h-6 w-4 cursor-grab items-center justify-center rounded opacity-0 transition-opacity',
              'group-hover:opacity-100',
            )}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/json', JSON.stringify(data));
              e.dataTransfer.effectAllowed = 'copyMove';
            }}
          >
            <GripVertical size={16} />
          </div>

          <div
            className={clsx(
              'flex-1 p-0',
              allowOverflow ? 'overflow-visible' : 'overflow-hidden',
            )}
          >
            {children}
          </div>

          <Handle
            type="target"
            id="top-target"
            position={Position.Top}
            className="bg-theme-500! -top-1! h-1! w-1! border-none! opacity-0 transition-opacity group-hover:opacity-100"
          />
          <Handle
            type="source"
            id="top-source"
            position={Position.Top}
            className="bg-theme-500! -top-1! h-1! w-1! border-none! opacity-0 transition-opacity group-hover:opacity-100"
          />
          <Handle
            type="target"
            id="right-target"
            position={Position.Right}
            className="bg-theme-500! -right-1! h-1! w-1! border-none! opacity-0 transition-opacity group-hover:opacity-100"
          />
          <Handle
            type="source"
            id="right-source"
            position={Position.Right}
            className="bg-theme-500! -right-1! h-1! w-1! border-none! opacity-0 transition-opacity group-hover:opacity-100"
          />
          <Handle
            type="target"
            id="bottom-target"
            position={Position.Bottom}
            className="bg-theme-500! -bottom-1! h-1! w-1! border-none! opacity-0 transition-opacity group-hover:opacity-100"
          />
          <Handle
            type="source"
            id="bottom-source"
            position={Position.Bottom}
            className="bg-theme-500! -bottom-1! h-1! w-1! border-none! opacity-0 transition-opacity group-hover:opacity-100"
          />
          <Handle
            type="target"
            id="left-target"
            position={Position.Left}
            className="bg-theme-500! -left-1! h-1! w-1! border-none! opacity-0 transition-opacity group-hover:opacity-100"
          />
          <Handle
            type="source"
            id="left-source"
            position={Position.Left}
            className="bg-theme-500! -left-1! h-1! w-1! border-none! opacity-0 transition-opacity group-hover:opacity-100"
          />
        </div>
      </>
    );
  },
);
