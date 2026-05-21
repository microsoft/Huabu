import {
  getSelectionBounds,
  getNodeSize,
  getAbsolutePosition,
  type NestableNode,
} from '@sediment/shared/canvas-engine';
import { useStore, useStoreApi, useViewport } from '@xyflow/react';
import { useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';

import { useIsTouch } from '@/hooks/useInputMode.ts';
import useCanvasStore from '@/store/canvasStore';

import type { CanvasNode } from '@/components/Nodes/types';

/**
 * Multi-select bounding-box resizer.
 *
 * When ≥2 nodes are selected, this component renders a single set of
 * 4 corner resize handles on the selection's bounding box (in screen
 * space, portalled into the React Flow container). Per-node handles
 * are suppressed by `NodeWrapper` while a multi-selection is active.
 *
 * Behaviour:
 *  - Default: free-axis scaling — each axis tracks the cursor
 *    independently (W and H change with the dragged corner's actual
 *    offset from the anchor).
 *  - Shift held: uniform (equiproportional) scaling — the dragged
 *    corner is constrained to the original bounding-box diagonal via
 *    projection so the aspect ratio is preserved.
 *  - The OPPOSITE corner of the dragged handle acts as the anchor and
 *    stays pinned in flow coordinates throughout the gesture.
 *  - Frame children whose parent is ALSO in the selection are skipped
 *    (they would otherwise be scaled twice — once by the parent move
 *    and once directly). Frame children whose parent is NOT selected
 *    are not part of the selection at all and stay put — i.e. selecting
 *    a frame and resizing it does NOT scale its children, matching the
 *    "children stay put" requirement.
 *  - Locked nodes are excluded from the gesture.
 *  - The whole gesture collapses into a single undo entry by going
 *    through `onNodeResizeStart()` (which calls `beginGesture('SET_NODE_GEOMETRY')`)
 *    and per-frame `setNodeGeometry()` updates.
 */

type Corner = 'tl' | 'tr' | 'bl' | 'br';

type SnapshotNode = {
  id: string;
  parentAbs: { x: number; y: number };
  pos0Abs: { x: number; y: number };
  size0: { width: number; height: number };
};

type ResizeSnapshot = {
  anchor: { x: number; y: number };
  /** corner0 - anchor, in flow coords */
  diag: { x: number; y: number };
  /** |diag|^2 — denominator for projection when in uniform (Shift) mode */
  diagLen2: number;
  nodes: SnapshotNode[];
};

/** Smallest scale we permit; prevents flipping past zero. */
const MIN_SCALE = 0.05;

export const MultiSelectResizer = () => {
  const nodes = useCanvasStore((s) => s.nodes);
  const setNodeGeometry = useCanvasStore((s) => s.setNodeGeometry);
  const onNodeResizeStart = useCanvasStore((s) => s.onNodeResizeStart);

  const isTouch = useIsTouch();
  const { zoom, x: vpX, y: vpY } = useViewport();
  const domNode = useStore((s) => s.domNode);
  const storeApi = useStoreApi();

  /** Snapshot captured on pointerdown; null when no gesture is active. */
  const snapshotRef = useRef<ResizeSnapshot | null>(null);

  const selectedNodes = useMemo(
    () => nodes.filter((n) => n.selected) as CanvasNode[],
    [nodes],
  );

  // Drop nodes whose ancestor is also selected so a frame and its child
  // selected together are not double-scaled.
  const eligibleNodes = useMemo(() => {
    const selectedIds = new Set(selectedNodes.map((n) => n.id));
    return selectedNodes.filter(
      (n) => !n.parentId || !selectedIds.has(n.parentId),
    );
  }, [selectedNodes]);

  // Live bounds in absolute flow coords. Recomputes after each
  // setNodeGeometry update so the outline + handles track the resize.
  // Uses the shared `getSelectionBounds` helper so the rendered box
  // stays consistent with the multi-select toolbar's anchor.
  const bounds = useMemo(() => {
    if (eligibleNodes.length < 2) return null;
    return getSelectionBounds(eligibleNodes, nodes);
  }, [eligibleNodes, nodes]);

  if (!bounds || !domNode) return null;

  // flow → pixel inside the .react-flow container.
  const minPx = { x: bounds.minX * zoom + vpX, y: bounds.minY * zoom + vpY };
  const maxPx = { x: bounds.maxX * zoom + vpX, y: bounds.maxY * zoom + vpY };
  const widthPx = Math.max(0, maxPx.x - minPx.x);
  const heightPx = Math.max(0, maxPx.y - minPx.y);

  const handleSize = isTouch ? 12 : 8;

  const startGesture = (corner: Corner, e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      // setPointerCapture can throw on detached targets — safe to ignore.
    }

    const anchor = {
      x: corner === 'tl' || corner === 'bl' ? bounds.maxX : bounds.minX,
      y: corner === 'tl' || corner === 'tr' ? bounds.maxY : bounds.minY,
    };
    const corner0 = {
      x: corner === 'tl' || corner === 'bl' ? bounds.minX : bounds.maxX,
      y: corner === 'tl' || corner === 'tr' ? bounds.minY : bounds.maxY,
    };
    const diag = { x: corner0.x - anchor.x, y: corner0.y - anchor.y };
    const diagLen2 = diag.x * diag.x + diag.y * diag.y;
    if (diagLen2 === 0) return;

    const snapNodes: SnapshotNode[] = [];
    for (const n of eligibleNodes) {
      if (n.data?.locked) continue;
      const abs =
        getAbsolutePosition(nodes as NestableNode[], n.id) ?? n.position;
      const parentAbs = n.parentId
        ? (getAbsolutePosition(nodes as NestableNode[], n.parentId) ?? {
            x: 0,
            y: 0,
          })
        : { x: 0, y: 0 };
      const { width, height } = getNodeSize(n);
      snapNodes.push({
        id: n.id,
        parentAbs,
        pos0Abs: abs,
        size0: { width: width || 200, height: height || 100 },
      });
    }
    if (snapNodes.length === 0) return;

    // Mark the start of an undoable gesture; subsequent setNodeGeometry
    // calls collapse into one history entry.
    onNodeResizeStart();
    snapshotRef.current = { anchor, diag, diagLen2, nodes: snapNodes };
  };

  const moveGesture = (e: React.PointerEvent) => {
    const snap = snapshotRef.current;
    if (!snap || !domNode) return;

    const rect = domNode.getBoundingClientRect();
    // Re-read viewport so an in-flight pan/zoom does not desync the math.
    const [tx, ty, tz] = storeApi.getState().transform;
    const cursorFlow = {
      x: (e.clientX - rect.left - tx) / tz,
      y: (e.clientY - rect.top - ty) / tz,
    };

    const offX = cursorFlow.x - snap.anchor.x;
    const offY = cursorFlow.y - snap.anchor.y;

    let scaleX: number;
    let scaleY: number;
    if (e.shiftKey) {
      // Uniform mode: project the cursor onto the original diagonal so
      // the dragged corner stays glued to it. Single shared scale.
      let scale = (offX * snap.diag.x + offY * snap.diag.y) / snap.diagLen2;
      if (!Number.isFinite(scale)) scale = 1;
      if (scale < MIN_SCALE) scale = MIN_SCALE;
      scaleX = scale;
      scaleY = scale;
    } else {
      // Free-axis mode: each axis tracks the cursor independently.
      // Matches the convention used by single-node resizing and most
      // 2D editors (Figma, Sketch, Illustrator).
      scaleX = snap.diag.x === 0 ? 1 : offX / snap.diag.x;
      scaleY = snap.diag.y === 0 ? 1 : offY / snap.diag.y;
      if (!Number.isFinite(scaleX)) scaleX = 1;
      if (!Number.isFinite(scaleY)) scaleY = 1;
      if (scaleX < MIN_SCALE) scaleX = MIN_SCALE;
      if (scaleY < MIN_SCALE) scaleY = MIN_SCALE;
    }

    const items = snap.nodes.map((n) => {
      const newAbsX = snap.anchor.x + (n.pos0Abs.x - snap.anchor.x) * scaleX;
      const newAbsY = snap.anchor.y + (n.pos0Abs.y - snap.anchor.y) * scaleY;
      return {
        nodeId: n.id,
        position: {
          x: newAbsX - n.parentAbs.x,
          y: newAbsY - n.parentAbs.y,
        },
        size: {
          width: n.size0.width * scaleX,
          height: n.size0.height * scaleY,
        },
      };
    });

    setNodeGeometry(items);
  };

  const endGesture = (e: React.PointerEvent) => {
    if (!snapshotRef.current) return;
    snapshotRef.current = null;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      // Already released — fine.
    }
  };

  const corners: ReadonlyArray<{ id: Corner; cursor: string }> = [
    { id: 'tl', cursor: 'nwse-resize' },
    { id: 'tr', cursor: 'nesw-resize' },
    { id: 'bl', cursor: 'nesw-resize' },
    { id: 'br', cursor: 'nwse-resize' },
  ];

  const overlay = (
    <div
      className="pointer-events-none absolute z-[999]"
      style={{
        left: minPx.x,
        top: minPx.y,
        width: widthPx,
        height: heightPx,
        // outline (not border) keeps the box dimensions exact so handle
        // offsets stay aligned with the bounding box.
        outline: '1px solid var(--color-info-light)',
        outlineOffset: 0,
      }}
    >
      {corners.map(({ id: corner, cursor }) => {
        const left =
          corner === 'tl' || corner === 'bl'
            ? -handleSize / 2
            : widthPx - handleSize / 2;
        const top =
          corner === 'tl' || corner === 'tr'
            ? -handleSize / 2
            : heightPx - handleSize / 2;
        return (
          <div
            key={corner}
            className="pointer-events-auto absolute"
            style={{
              left,
              top,
              width: handleSize,
              height: handleSize,
              background: 'var(--color-info-light)',
              border: '1px solid white',
              boxSizing: 'border-box',
              cursor,
              touchAction: 'none',
            }}
            onPointerDown={(e) => startGesture(corner, e)}
            onPointerMove={moveGesture}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
          />
        );
      })}
    </div>
  );

  return createPortal(overlay, domNode);
};
