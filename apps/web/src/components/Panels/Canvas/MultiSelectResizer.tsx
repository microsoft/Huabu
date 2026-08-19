// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useStore, useStoreApi, useViewport } from '@xyflow/react';
import { useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';

import {
  getSelectionBounds,
  getNodeSize,
  getAbsolutePosition,
  type NestableNode,
} from '@huabu/shared/canvas-engine';

import { resumeHeightCommits } from '@/components/Nodes/shared/height/commitSuspension';
import { useIsNotMouse } from '@/hooks/useInputMode.ts';
import useCanvasStore from '@/store/canvasStore';
import {
  getNodeFontFit,
  refitFont,
  type NodeFontFit,
} from '@/utils/node/fontFit';

import type { CanvasNode } from '@/components/Nodes/types';
import type { NodeStyle } from '@huabu/shared';

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
 *  - Shift held or Image/Video present: uniform (equiproportional)
 *    scaling — the dragged corner is constrained to the original
 *    bounding-box diagonal via projection so aspect ratios are preserved.
 *  - The OPPOSITE corner of the dragged handle acts as the anchor and
 *    stays pinned in flow coordinates throughout the gesture.
 *  - A selected Frame is a scaling root: its complete descendant subtree is
 *    transformed with the Frame so the resized Frame continues to contain
 *    its children. Nested selected Frames are handled by their outermost
 *    selected ancestor and are not scaled a second time.
 *  - Canvas-level interaction locking prevents the gesture from starting;
 *    descendants of a selected Frame are always included so containment is
 *    preserved.
 *  - The whole gesture collapses into a single undo entry by going
 *    through `onNodeResizeStart()` (which calls `beginGesture('SET_NODE_GEOMETRY')`)
 *    with preview updates during movement and one final geometry commit.
 */

type Corner = 'tl' | 'tr' | 'bl' | 'br';

type SnapshotNode = {
  id: string;
  parentId?: string;
  scaleRootId: string | null;
  parentAbs: { x: number; y: number };
  pos0Abs: { x: number; y: number };
  size0: { width: number; height: number };
  preserveAspectRatio: boolean;
  style?: NodeStyle;
  fontFit?: NodeFontFit | null;
};

type ResizeSnapshot = {
  anchor: { x: number; y: number };
  /** corner0 - anchor, in flow coords */
  diag: { x: number; y: number };
  /** |diag|^2 — denominator for projection when in uniform (Shift) mode */
  diagLen2: number;
  nodes: SnapshotNode[];
};

export function resolveMultiSelectGeometry({
  snapshot,
  scaleX,
  scaleY,
}: {
  snapshot: ResizeSnapshot;
  scaleX: number;
  scaleY: number;
}): Array<{
  nodeId: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
}> {
  const newAbsById = new Map<string, { x: number; y: number }>();
  const newSizeById = new Map<string, { width: number; height: number }>();
  const snapshotById = new Map(snapshot.nodes.map((node) => [node.id, node]));

  for (const node of snapshot.nodes) {
    const root = node.scaleRootId
      ? snapshotById.get(node.scaleRootId)
      : undefined;
    let newAbs = {
      x: snapshot.anchor.x + (node.pos0Abs.x - snapshot.anchor.x) * scaleX,
      y: snapshot.anchor.y + (node.pos0Abs.y - snapshot.anchor.y) * scaleY,
    };
    if (root) {
      const rootAbs = newAbsById.get(root.id) ?? {
        x: snapshot.anchor.x + (root.pos0Abs.x - snapshot.anchor.x) * scaleX,
        y: snapshot.anchor.y + (root.pos0Abs.y - snapshot.anchor.y) * scaleY,
      };
      newAbs = {
        x: rootAbs.x + (node.pos0Abs.x - root.pos0Abs.x) * scaleX,
        y: rootAbs.y + (node.pos0Abs.y - root.pos0Abs.y) * scaleY,
      };
    }
    newAbsById.set(node.id, newAbs);
    newSizeById.set(node.id, {
      width: node.size0.width * scaleX,
      height: node.size0.height * scaleY,
    });
  }

  return snapshot.nodes.map((node) => {
    const newAbs = newAbsById.get(node.id)!;
    const newParentAbs = node.parentId
      ? (newAbsById.get(node.parentId) ?? node.parentAbs)
      : { x: 0, y: 0 };
    return {
      nodeId: node.id,
      position: {
        x: newAbs.x - newParentAbs.x,
        y: newAbs.y - newParentAbs.y,
      },
      size: newSizeById.get(node.id)!,
    };
  });
}

export function canSnapshotMultiSelectRoot(node: {
  data?: { locked?: boolean };
}): boolean {
  return !node.data?.locked;
}

/** Smallest scale we permit; prevents flipping past zero. */
const MIN_SCALE = 0.05;

export function resolveMultiSelectScale({
  offX,
  offY,
  diag,
  diagLen2,
  uniform,
}: {
  offX: number;
  offY: number;
  diag: { x: number; y: number };
  diagLen2: number;
  uniform: boolean;
}): { scaleX: number; scaleY: number } {
  if (uniform) {
    let scale = (offX * diag.x + offY * diag.y) / diagLen2;
    if (!Number.isFinite(scale)) scale = 1;
    if (scale < MIN_SCALE) scale = MIN_SCALE;
    return { scaleX: scale, scaleY: scale };
  }

  let scaleX = diag.x === 0 ? 1 : offX / diag.x;
  let scaleY = diag.y === 0 ? 1 : offY / diag.y;
  if (!Number.isFinite(scaleX)) scaleX = 1;
  if (!Number.isFinite(scaleY)) scaleY = 1;
  if (scaleX < MIN_SCALE) scaleX = MIN_SCALE;
  if (scaleY < MIN_SCALE) scaleY = MIN_SCALE;
  return { scaleX, scaleY };
}

export const MultiSelectResizer = () => {
  const nodes = useCanvasStore((s) => s.nodes);
  const setNodeGeometry = useCanvasStore((s) => s.setNodeGeometry);
  const previewResizeGeometry = useCanvasStore((s) => s.previewResizeGeometry);
  const patchNodeSilent = useCanvasStore((s) => s.patchNodeSilent);
  const onNodeResizeStart = useCanvasStore((s) => s.onNodeResizeStart);

  const isDirectManipulation = useIsNotMouse();
  const { zoom, x: vpX, y: vpY } = useViewport();
  const domNode = useStore((s) => s.domNode);
  const storeApi = useStoreApi();

  /** Snapshot captured on pointerdown; null when no gesture is active. */
  const snapshotRef = useRef<ResizeSnapshot | null>(null);
  const latestItemsRef = useRef<ReturnType<typeof resolveMultiSelectGeometry>>(
    [],
  );
  const lastAppliedFontRef = useRef(new Map<string, number>());

  const selectedNodes = useMemo(
    () => nodes.filter((n) => n.selected) as CanvasNode[],
    [nodes],
  );

  // Drop nodes whose ancestor is also selected so a frame and its child
  // selected together are not double-scaled.
  const eligibleNodes = useMemo(() => {
    if (
      selectedNodes.some(
        (node) => node.type === 'canvasRef' || node.type === 'frameRef',
      )
    ) {
      return [];
    }
    const selectedIds = new Set(selectedNodes.map((n) => n.id));
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return selectedNodes.filter((node) => {
      let parentId = node.parentId;
      const visited = new Set<string>();
      while (parentId && !visited.has(parentId)) {
        if (selectedIds.has(parentId)) return false;
        visited.add(parentId);
        parentId = nodeById.get(parentId)?.parentId;
      }
      return true;
    });
  }, [nodes, selectedNodes]);

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

  const handleSize = isDirectManipulation ? 12 : 8;

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
    const snapshottedIds = new Set<string>();
    const childrenByParentId = new Map<string, CanvasNode[]>();
    for (const node of nodes as CanvasNode[]) {
      if (!node.parentId) continue;
      const children = childrenByParentId.get(node.parentId) ?? [];
      children.push(node);
      childrenByParentId.set(node.parentId, children);
    }
    const addSnapshotSubtree = (
      node: CanvasNode,
      scaleRootId: string | null,
    ) => {
      if (snapshottedIds.has(node.id)) return;
      snapshottedIds.add(node.id);
      const abs =
        getAbsolutePosition(nodes as NestableNode[], node.id) ?? node.position;
      const parentAbs = node.parentId
        ? (getAbsolutePosition(nodes as NestableNode[], node.parentId) ?? {
            x: 0,
            y: 0,
          })
        : { x: 0, y: 0 };
      const { width, height } = getNodeSize(node);
      const style = (node.data as { style?: NodeStyle } | undefined)?.style;
      snapNodes.push({
        id: node.id,
        parentId: node.parentId,
        scaleRootId,
        parentAbs,
        pos0Abs: abs,
        size0: { width: width || 200, height: height || 100 },
        preserveAspectRatio: node.type === 'image' || node.type === 'video',
        style,
        fontFit: getNodeFontFit(node),
      });
      for (const child of childrenByParentId.get(node.id) ?? []) {
        addSnapshotSubtree(child, scaleRootId);
      }
    };
    for (const n of eligibleNodes) {
      if (!canSnapshotMultiSelectRoot(n)) continue;
      addSnapshotSubtree(n, n.type === 'frame' ? n.id : null);
    }
    if (snapNodes.length === 0) return;

    // Mark the start of an undoable gesture; subsequent setNodeGeometry
    // calls collapse into one history entry.
    onNodeResizeStart();
    latestItemsRef.current = [];
    lastAppliedFontRef.current.clear();
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

    const { scaleX, scaleY } = resolveMultiSelectScale({
      offX,
      offY,
      diag: snap.diag,
      diagLen2: snap.diagLen2,
      uniform:
        e.shiftKey || snap.nodes.some((node) => node.preserveAspectRatio),
    });

    const items = resolveMultiSelectGeometry({
      snapshot: snap,
      scaleX,
      scaleY,
    });
    latestItemsRef.current = items;
    previewResizeGeometry(items);
    const itemById = new Map(items.map((item) => [item.nodeId, item]));
    for (const node of snap.nodes) {
      if (!node.fontFit) continue;
      const item = itemById.get(node.id);
      if (!item) continue;
      const fontSize = refitFont(
        node.fontFit,
        item.size.width,
        item.size.height,
      );
      if (!Number.isFinite(fontSize) || fontSize <= 0) continue;
      if (lastAppliedFontRef.current.get(node.id) === fontSize) continue;
      lastAppliedFontRef.current.set(node.id, fontSize);
      patchNodeSilent(node.id, {
        style: { ...(node.style ?? {}), fontSize },
      });
    }
  };

  const endGesture = (e: React.PointerEvent) => {
    if (!snapshotRef.current) return;
    snapshotRef.current = null;
    const items = latestItemsRef.current;
    latestItemsRef.current = [];
    lastAppliedFontRef.current.clear();
    if (items.length > 0) setNodeGeometry(items);
    resumeHeightCommits('node-resize');
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
      className="pointer-events-none absolute z-999"
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
