// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useRef } from 'react';

import {
  computeFrameFit,
  getAbsolutePosition,
  getFrameSizing,
  getSketchRenderedSize,
} from '@huabu/shared/canvas-engine';

import {
  buildMoveStrokesCommands,
  commitStrokeCommands,
} from '@/components/Nodes/sketch/sketchMerge';
import { resolveFrameAtPoint } from '@/handler/canvasCommand/utils';
import {
  beginCanvasGesture,
  endCanvasGesture,
  updateCanvasGesture,
  type CanvasPointerType,
} from '@/handler/canvasGestureSession';
import useCanvasStore from '@/store/canvasStore';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import type { FrameFitPreview } from '@/store/gesturePreviewStore';
import type { CanvasCommand, CanvasNodeId } from '@huabu/shared';
import type { NestableNode } from '@huabu/shared/canvas-engine';
import type { Node, NodeChange, ReactFlowInstance } from '@xyflow/react';
import type { MutableRefObject } from 'react';

/**
 * The canvas store's drag lifecycle callbacks (`onNodeDragStart`,
 * `onNodeDrag`, `onNodeDragStop`) are typed as DOM `MouseEvent` handlers but
 * only read a handful of fields: the modifier keys (`altKey` gates
 * duplicate-on-drag; the others feed snap / structured-drop) plus
 * `clientX`/`clientY`. Forward the REAL values from the driving pointer
 * event rather than hardcoding them, so this stays correct if the store
 * starts reading another modifier.
 */
function asDragMouseEvent(event: PointerEvent): MouseEvent {
  return {
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    clientX: event.clientX,
    clientY: event.clientY,
  } as unknown as MouseEvent;
}

/**
 * Stage 4B drop decision for a PURE stroke selection, based on the drop
 * point:
 *  - over a DIFFERENT sketch region        → `merge` into it,
 *  - over empty canvas (outside every source region) → `split` into a
 *    brand-new region,
 *  - still inside a source region           → `in-node` (plain Stage-2
 *    translate, no re-homing).
 *
 * Region bboxes are computed in ABSOLUTE flow (`getAbsolutePosition`) so
 * framed regions hit-test correctly. On overlap the visually-frontmost
 * (last in array) region wins.
 */
type StrokeDropDecision =
  | { kind: 'merge'; targetNodeId: CanvasNodeId }
  | { kind: 'split'; targetNodeId: null }
  | { kind: 'in-node' };

function resolveStrokeDropTarget(
  nodes: Node[],
  point: { x: number; y: number },
  sourceIds: string[],
): StrokeDropDecision {
  const nn = nodes as unknown as NestableNode[];
  const sourceSet = new Set(sourceIds);
  const contains = (node: Node): boolean => {
    if (node.type !== 'sketch') return false;
    const abs = getAbsolutePosition(nn, node.id) ?? node.position;
    const { width: w, height: h } = getSketchRenderedSize(node);
    return (
      point.x >= abs.x &&
      point.x <= abs.x + w &&
      point.y >= abs.y &&
      point.y <= abs.y + h
    );
  };

  // Prefer merging into a non-source region under the drop point.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (sourceSet.has(node.id)) continue;
    if (contains(node)) {
      return { kind: 'merge', targetNodeId: node.id as CanvasNodeId };
    }
  }

  // No foreign region hit: still inside a source → in-node; else split.
  for (const id of sourceIds) {
    const node = nodes.find((n) => n.id === id);
    if (node && contains(node)) return { kind: 'in-node' };
  }
  return { kind: 'split', targetNodeId: null };
}

/** Axis-aligned flow bbox of a polygon, translated by a drag offset. */
function polygonBoundsWithOffset(
  poly: Array<{ x: number; y: number }>,
  offset: { dx: number; dy: number },
): { x: number; y: number; width: number; height: number } | null {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const p of poly) {
    if (p.x < x1) x1 = p.x;
    if (p.y < y1) y1 = p.y;
    if (p.x > x2) x2 = p.x;
    if (p.y > y2) y2 = p.y;
  }
  if (!Number.isFinite(x1)) return null;
  return {
    x: x1 + offset.dx,
    y: y1 + offset.dy,
    width: x2 - x1,
    height: y2 - y1,
  };
}

/**
 * While a PURE stroke selection is being dragged, mirror the frame
 * accept-preview a whole-node drag gets for free (via the store's
 * `onNodeDrag` → `computeFrameFit`). Shown only for the SPLIT case — drop
 * point over a frame and NOT merging into another region — since only then
 * does a new region get reparented into that frame; cleared otherwise
 * (merge / in-node / blank top-level). Reuses the same `computeFrameFit`
 * + `setFrameFitPreviews` path so the overlay renders identically to a
 * node drag; the incoming rect is the retained lasso polygon's bounds
 * translated by the live drag offset.
 */
function updateFrameDropPreviewForStrokeDrag(
  dropFlow: { x: number; y: number },
  offset: { dx: number; dy: number },
): void {
  const gp = useGesturePreviewStore.getState();
  const nodes = useCanvasStore.getState().nodes;
  const sel = gp.sketchStrokeSelection;
  const sourceIds = Object.keys(sel).filter((id) => (sel[id]?.length ?? 0) > 0);
  if (sourceIds.length === 0) {
    gp.clearFrameFitPreview();
    return;
  }

  const nn = nodes as unknown as NestableNode[];
  // Only a SPLIT reparents into a frame; merge / in-node do not.
  const decision = resolveStrokeDropTarget(nodes, dropFlow, sourceIds);
  const hit =
    decision.kind === 'split' ? resolveFrameAtPoint(nn, dropFlow) : null;
  const frameNode = hit ? nodes.find((n) => n.id === hit.parentId) : undefined;
  if (!hit || !frameNode) {
    gp.clearFrameFitPreview();
    return;
  }
  const frameId = hit.parentId;

  // Grow-to-fit preview for `hug` frames (matches node drag); a manual
  // (pinned) frame just highlights its current bounds as the drop target.
  const poly = gp.sketchSelectionPolygon;
  const movedRect = poly ? polygonBoundsWithOffset(poly, offset) : null;
  const fit =
    movedRect && getFrameSizing(frameNode) === 'hug'
      ? computeFrameFit(nn, frameId, { includeAbsoluteRects: [movedRect] })
      : null;

  let preview: FrameFitPreview;
  if (fit) {
    let absX = fit.position.x;
    let absY = fit.position.y;
    if (frameNode.parentId) {
      const pa = getAbsolutePosition(nn, frameNode.parentId);
      if (pa) {
        absX += pa.x;
        absY += pa.y;
      }
    }
    preview = {
      frameId,
      position: { x: absX, y: absY },
      width: fit.width,
      height: fit.height,
      role: 'target',
    };
  } else {
    const fa = getAbsolutePosition(nn, frameId) ?? frameNode.position;
    preview = {
      frameId,
      position: { x: fa.x, y: fa.y },
      width: frameNode.measured?.width ?? frameNode.width ?? 0,
      height: frameNode.measured?.height ?? frameNode.height ?? 0,
      role: 'target',
    };
  }

  gp.setFrameFitPreviews([preview]);
}

/**
 * Stage 2 "move" gesture for a stroke-level selection (GoodNotes-style).
 *
 * The retained lasso polygon (`gesturePreviewStore.sketchSelectionPolygon`)
 * stays after selection; a pointerdown *inside* it (gated by the Canvas
 * recognizer's `canClaim`) grabs the selection and drags it. While dragging
 * we publish a live flow-space offset (`sketchStrokeMovePreview`) that
 * `SketchNode` + the region overlay render as a translate; on pointer-up we
 * bake the offset into each affected sketch node via
 * {@link buildMoveStrokesCommands} (in-node translate + bbox reflow), and
 * translate the retained polygon so it keeps surrounding the strokes.
 *
 * When the lasso also captured whole nodes (a mixed selection), those
 * selected nodes move *together* with the strokes: they are driven live
 * through the store's regular drag lifecycle (`onNodeDragStart` →
 * `onNodesChange` position ticks → `onNodeDragStop`) — the same path
 * {@link file://./../handler/canvasPointerRecognizers/nodeDrag.ts} uses — so
 * smart-snap, frame re-parenting, and autosave behave identically to a
 * normal drag, and the stroke bake folds into that gesture's single undo
 * entry (no second snapshot).
 *
 * Wired into the pointer router *before* the lasso recognizer, so grabbing
 * the selection takes precedence over starting a fresh lasso.
 */
export function useSketchStrokeMove({
  rfInstanceRef,
}: {
  rfInstanceRef: MutableRefObject<ReactFlowInstance | null>;
}) {
  const dragRef = useRef<{
    pointerId: number;
    startFlow: { x: number; y: number };
    /** Selected whole nodes to drag alongside the strokes (mixed selection). */
    draggedNodes: Node[];
    primaryNode: Node | null;
    startPositions: Map<string, { x: number; y: number }>;
    /** Whether the store drag lifecycle has been opened for the nodes. */
    nodeDragStarted: boolean;
    /**
     * Sketch nodes carried by a dragged ancestor (framed sketch lassoed
     * with its frame). Their strokes must NOT be baked by the move offset
     * on commit — the ancestor drag already moves the whole node.
     */
    carriedSketchNodeIds: Set<string>;
  } | null>(null);

  const positionChanges = (
    startPositions: Map<string, { x: number; y: number }>,
    dx: number,
    dy: number,
    dragging: boolean,
  ): NodeChange[] =>
    Array.from(startPositions.entries()).map(([id, start]) => ({
      type: 'position',
      id,
      position: { x: start.x + dx, y: start.y + dy },
      dragging,
    }));

  const onPointerDown = useCallback(
    (event: PointerEvent): boolean => {
      const inst = rfInstanceRef.current;
      if (!inst) return false;
      // Drag any whole nodes the lasso also selected together with the
      // strokes. Sketch nodes are never whole-node selected (their strokes
      // move via the bake), so exclude them defensively. Also exclude any
      // node whose parent is itself selected: a framed child follows its
      // parent's move automatically (relative position), so moving both
      // would apply the delta twice and fling the child out of the frame.
      const allSelected = useCanvasStore
        .getState()
        .nodes.filter((n) => n.selected && n.type !== 'sketch') as Node[];
      const selectedIds = new Set(allSelected.map((n) => n.id));
      const allNodes = useCanvasStore.getState().nodes;
      const nodeById = new Map(allNodes.map((n) => [n.id, n]));
      const hasSelectedAncestor = (nodeId: string): boolean => {
        let parentId = nodeById.get(nodeId)?.parentId;
        const seen = new Set<string>();
        while (parentId && !seen.has(parentId)) {
          if (selectedIds.has(parentId)) return true;
          seen.add(parentId);
          parentId = nodeById.get(parentId)?.parentId;
        }
        return false;
      };
      const selectedNodes = allSelected.filter(
        (node) => !hasSelectedAncestor(node.id),
      );
      // Sketch nodes whose strokes are selected but that sit inside a
      // dragged node (e.g. a framed sketch lassoed together with its
      // frame) are carried by that ancestor's drag: their whole SVG moves
      // by the group delta already, so the stroke move-preview / bake must
      // NOT be applied on top (that would move the strokes twice, flinging
      // them out of the frame). Walk each candidate's parent chain against
      // the dragged-node set to find them.
      const draggedIds = new Set(selectedNodes.map((n) => n.id));
      const isCarriedByDrag = (nodeId: string): boolean => {
        let parentId = nodeById.get(nodeId)?.parentId;
        const seen = new Set<string>();
        while (parentId && !seen.has(parentId)) {
          if (draggedIds.has(parentId)) return true;
          seen.add(parentId);
          parentId = nodeById.get(parentId)?.parentId;
        }
        return false;
      };
      const carriedSketchNodeIds = new Set(
        Object.keys(
          useGesturePreviewStore.getState().sketchStrokeSelection,
        ).filter((id) => isCarriedByDrag(id)),
      );
      const startScreen = { x: event.clientX, y: event.clientY };
      if (
        !beginCanvasGesture(
          'sketch-stroke-move',
          event.pointerId,
          event.pointerType as CanvasPointerType,
          startScreen,
        )
      ) {
        return false;
      }
      dragRef.current = {
        pointerId: event.pointerId,
        startFlow: inst.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        }),
        draggedNodes: selectedNodes,
        primaryNode: selectedNodes[0] ?? null,
        startPositions: new Map(
          selectedNodes.map((n) => [
            n.id,
            { x: n.position.x, y: n.position.y },
          ]),
        ),
        nodeDragStarted: false,
        carriedSketchNodeIds,
      };
      // Reset any stale preview from a previous drag.
      useGesturePreviewStore.getState().setSketchStrokeMovePreview(null);
      useGesturePreviewStore
        .getState()
        .setSketchStrokeMoveCarriedNodeIds(Array.from(carriedSketchNodeIds));
      return true;
    },
    [rfInstanceRef],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const inst = rfInstanceRef.current;
      if (!inst) return;
      const cur = inst.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      const phase = updateCanvasGesture(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
      if (phase !== 'locked') return;
      const dx = cur.x - drag.startFlow.x;
      const dy = cur.y - drag.startFlow.y;

      if (drag.draggedNodes.length > 0) {
        const store = useCanvasStore.getState();
        if (!drag.nodeDragStarted) {
          drag.nodeDragStarted = true;
          // Snapshots pre-drag positions + starts the snap session (one
          // undo entry for the whole move).
          store.onNodeDragStart(
            asDragMouseEvent(event),
            drag.primaryNode as Node,
            drag.draggedNodes,
          );
        }
        store.onNodesChange(positionChanges(drag.startPositions, dx, dy, true));
        // Drive the live frame-fit / structured-drop preview tick too, so a
        // framed child's parent visibly grows to follow it (matching a
        // native React Flow drag). Without this the child appears to float
        // out of its frame mid-drag even though it lands correctly.
        store.onNodeDrag(
          asDragMouseEvent(event),
          drag.primaryNode as Node,
          drag.draggedNodes,
        );
        // Sync the stroke translate to the nodes' SNAPPED delta. onNodesChange
        // applies smart-snap to the dragged nodes, so translating the strokes
        // by the RAW pointer delta would drift them off the snapped nodes —
        // a sketch stroke lassoed together with a frame would slide out of it.
        // The group moves rigidly by a single snapped delta, so read the
        // primary node's actual post-snap position delta and move the strokes
        // by the same amount. `primaryNode` is always top-level (or has a
        // stationary, unselected parent), so its local position delta equals
        // the flow-space group delta.
        const primary = drag.primaryNode;
        const startPos = primary
          ? drag.startPositions.get(primary.id)
          : undefined;
        const livePrimary = primary
          ? useCanvasStore.getState().nodes.find((n) => n.id === primary.id)
          : undefined;
        const synced =
          startPos && livePrimary
            ? {
                dx: livePrimary.position.x - startPos.x,
                dy: livePrimary.position.y - startPos.y,
              }
            : { dx, dy };
        useGesturePreviewStore.getState().setSketchStrokeMovePreview(synced);
      } else {
        // Pure stroke drag: no node-drag lifecycle runs, so move by the raw
        // pointer delta and mirror the frame accept-preview (shown only when
        // the strokes would split into a frame).
        useGesturePreviewStore
          .getState()
          .setSketchStrokeMovePreview({ dx, dy });
        updateFrameDropPreviewForStrokeDrag(cur, { dx, dy });
      }
    },
    [rfInstanceRef],
  );

  const commit = useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    endCanvasGesture(event.pointerId);

    const preview = useGesturePreviewStore.getState();
    const offset = preview.sketchStrokeMovePreview;
    preview.setSketchStrokeMovePreview(null);
    preview.setSketchStrokeMoveCarriedNodeIds([]);
    preview.clearFrameFitPreview();
    const moved = !!offset && (offset.dx !== 0 || offset.dy !== 0);
    const store = useCanvasStore.getState();

    // Stage 4B: a PURE stroke selection (no whole-node drag) dropped onto a
    // DIFFERENT region or empty canvas is a cross-region transfer — split
    // into a new region or merge into another — rather than a Stage-2
    // in-node translate. Mixed selections keep the in-node behaviour below.
    if (moved && offset && !drag.nodeDragStarted) {
      const inst = rfInstanceRef.current;
      const sel = preview.sketchStrokeSelection;
      const sourceIds = Object.keys(sel).filter(
        (id) => (sel[id]?.length ?? 0) > 0,
      );
      if (inst && sourceIds.length > 0) {
        const dropFlow = inst.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        });
        const decision = resolveStrokeDropTarget(
          store.nodes,
          dropFlow,
          sourceIds,
        );
        if (decision.kind !== 'in-node') {
          const sources = sourceIds.map((id) => ({
            nodeId: id,
            strokeIds: sel[id],
          }));
          // The strokes are about to move to a new / other node, so the
          // per-node selection map and retained lasso loop no longer
          // describe them — clear the transient selection first.
          preview.clearSketchStrokeSelection();
          store.moveSketchStrokesToRegion({
            sources,
            dropDelta: { dx: offset.dx, dy: offset.dy },
            targetNodeId: decision.targetNodeId,
            dropPoint: dropFlow,
          });
          return;
        }
      }
    }

    // Bake the stroke subset move into each affected sketch node.
    const strokeCommands: CanvasCommand[] = [];
    if (moved) {
      for (const [nodeId, strokeIds] of Object.entries(
        preview.sketchStrokeSelection,
      )) {
        if (strokeIds.length === 0) continue;
        // A sketch carried by a dragged ancestor already moves with it;
        // baking the offset here would double-move its strokes.
        if (drag.carriedSketchNodeIds.has(nodeId)) continue;
        strokeCommands.push(
          ...buildMoveStrokesCommands(
            nodeId as CanvasNodeId,
            new Set(strokeIds),
            offset.dx,
            offset.dy,
          ),
        );
      }
    }

    if (drag.nodeDragStarted) {
      // Mixed move: settle the live node positions, then close the node
      // drag lifecycle FIRST — its NODE_DRAG_STOP intent consumes the undo
      // snapshot taken by onNodeDragStart (reparent + geometry as one undo
      // entry). Only then fold the stroke bake into that SAME entry, so
      // executeCommands neither warns ("caller command without
      // beginGesture") nor pushes a second snapshot.
      const dx = offset?.dx ?? 0;
      const dy = offset?.dy ?? 0;
      store.onNodesChange(positionChanges(drag.startPositions, dx, dy, false));
      store.onNodeDragStop(
        asDragMouseEvent(event),
        drag.primaryNode as Node,
        drag.draggedNodes,
      );
      commitStrokeCommands(strokeCommands, { foldIntoOpenGesture: true });
    } else {
      // Pure stroke move: own single-entry undo gesture.
      commitStrokeCommands(strokeCommands);
    }

    // Keep the retained polygon around the moved strokes.
    if (moved) {
      const poly = preview.sketchSelectionPolygon;
      if (poly) {
        preview.setSketchSelectionPolygon(
          poly.map((p) => ({ x: p.x + offset.dx, y: p.y + offset.dy })),
        );
      }
    }
  }, []);

  const onPointerCancel = useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    endCanvasGesture(event.pointerId);
    useGesturePreviewStore.getState().setSketchStrokeMovePreview(null);
    useGesturePreviewStore.getState().setSketchStrokeMoveCarriedNodeIds([]);
    useGesturePreviewStore.getState().clearFrameFitPreview();
    // Abort the node drag lifecycle if it was opened.
    if (drag.nodeDragStarted) {
      useCanvasStore.getState().cancelActiveNodeDrag();
    }
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: commit,
    onPointerCancel,
  };
}
