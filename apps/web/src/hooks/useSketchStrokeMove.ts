import { useCallback, useRef } from 'react';

import { buildMoveStrokesCommands } from '@/components/Nodes/sketch/sketchMerge';
import { canvasHistoryManager } from '@/store/canvasHistoryManager';
import useCanvasStore from '@/store/canvasStore';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import type { CanvasCommand, CanvasNodeId } from '@sediment/shared';
import type { Node, NodeChange, ReactFlowInstance } from '@xyflow/react';
import type { MutableRefObject } from 'react';

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
  } | null>(null);

  // The store's drag callbacks are typed as DOM mouse handlers; synthesize
  // the only fields they read (`altKey`, `clientX`/`clientY`).
  const dragEvent = (extra?: {
    clientX: number;
    clientY: number;
  }): MouseEvent => ({ altKey: false, ...extra }) as unknown as MouseEvent;

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
      const selectedNodes = allSelected.filter(
        (n) => !n.parentId || !selectedIds.has(n.parentId),
      );
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
      };
      // Reset any stale preview from a previous drag.
      useGesturePreviewStore.getState().setSketchStrokeMovePreview(null);
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
      const dx = cur.x - drag.startFlow.x;
      const dy = cur.y - drag.startFlow.y;
      useGesturePreviewStore.getState().setSketchStrokeMovePreview({ dx, dy });

      if (drag.draggedNodes.length > 0) {
        const store = useCanvasStore.getState();
        if (!drag.nodeDragStarted) {
          drag.nodeDragStarted = true;
          // Snapshots pre-drag positions + starts the snap session (one
          // undo entry for the whole move).
          store.onNodeDragStart(
            dragEvent(),
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
          dragEvent({ clientX: event.clientX, clientY: event.clientY }),
          drag.primaryNode as Node,
          drag.draggedNodes,
        );
      }
    },
    [rfInstanceRef],
  );

  const commit = useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;

    const preview = useGesturePreviewStore.getState();
    const offset = preview.sketchStrokeMovePreview;
    preview.setSketchStrokeMovePreview(null);
    const moved = !!offset && (offset.dx !== 0 || offset.dy !== 0);
    const store = useCanvasStore.getState();

    // Bake the stroke subset move into each affected sketch node.
    const strokeCommands: CanvasCommand[] = [];
    if (moved) {
      for (const [nodeId, strokeIds] of Object.entries(
        preview.sketchStrokeSelection,
      )) {
        if (strokeIds.length === 0) continue;
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
      // entry). Only then fold the stroke bake into that SAME entry by
      // re-arming the gesture-snapshot flag, so executeCommands neither
      // warns ("caller command without beginGesture") nor pushes a second
      // snapshot.
      const dx = offset?.dx ?? 0;
      const dy = offset?.dy ?? 0;
      store.onNodesChange(positionChanges(drag.startPositions, dx, dy, false));
      store.onNodeDragStop(
        dragEvent({ clientX: event.clientX, clientY: event.clientY }),
        drag.primaryNode as Node,
        drag.draggedNodes,
      );
      if (strokeCommands.length > 0) {
        canvasHistoryManager.markGestureSnapshot();
        store.executeCommands(strokeCommands, 'ui');
      }
    } else if (strokeCommands.length > 0) {
      // Pure stroke move: own single-entry undo gesture.
      if (strokeCommands.some((c) => c.type === 'SET_NODE_GEOMETRY')) {
        store.beginGesture('SET_NODE_GEOMETRY');
      }
      store.executeCommands(strokeCommands, 'ui');
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
    useGesturePreviewStore.getState().setSketchStrokeMovePreview(null);
    // Abort the node drag lifecycle if it was opened.
    if (drag.nodeDragStarted) {
      const store = useCanvasStore.getState();
      store.onNodesChange(positionChanges(drag.startPositions, 0, 0, false));
      store.onNodeDragStop(
        dragEvent(),
        drag.primaryNode as Node,
        drag.draggedNodes,
      );
    }
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: commit,
    onPointerCancel,
  };
}
