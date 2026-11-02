// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getAncestorIds, indexById } from '@huabu/shared/canvas-engine';

import {
  isNodeControlTarget,
  isPanelTarget,
} from '@/components/Panels/Canvas/canvasInputPolicy';
import { getDragActivationDistance } from '@/handler/canvasGestureSession';
import { nodeIdAtScreenPoint } from '@/handler/canvasNodeAtPoint';
import { getFrameDragRoots } from '@/handler/frameDragSelection';
import useCanvasStore from '@/store/canvasStore';
import { useInkSigilStore } from '@/store/inkSigilStore';

import type { CanvasPointerRouterContext } from '@/handler/canvasPointerRouterContext';
import type { PointerRecognizer } from '@/handler/pointerRouter';
import type { Node, NodeChange } from '@xyflow/react';

/**
 * Finger-drag of an already-selected node in Pen mode.
 *
 * Pen mode splits the two physical inputs: the pen owns ink / direct
 * manipulation, the finger owns navigation + selection. This recognizer
 * extends that split so a finger pressing an *already-selected* node and
 * dragging moves it — matching pen-first note apps (GoodNotes, Procreate)
 * where the pen keeps drawing while the finger rearranges objects. A
 * finger on empty canvas or an unselected node still falls through to
 * viewport navigation / tap-select (see `viewport-navigation`), which is
 * why this recognizer is offered *before* it and only claims selected
 * nodes.
 *
 * The move is driven through the store's existing drag lifecycle
 * (`onNodeDragStart` → `onNodesChange` / `onNodeDrag` ticks → `onNodeDragStop`)
 * rather than React Flow's own pointer drag. That indirection is
 * deliberate: while the Sketch tool is armed React Flow node dragging is
 * disabled (`nodesDraggable={false}`) and the full-screen overlay covers
 * the nodes, so the finger never reaches React Flow at all. Re-using the
 * store methods keeps smart-snap, frame re-parenting, autosave, and
 * single-entry undo byte-for-byte identical to a mouse or pen drag — the
 * recognizer only supplies the position deltas React Flow would normally
 * emit.
 *
 * By default it is gated to `inputMode === 'pen'`: in Finger mode the finger under
 * the Select tool already drags selected nodes through React Flow
 * natively, and under Sketch the finger draws; in Mouse mode the pointer
 * is never touch.
 */
export function createNodeDragRecognizer(options?: {
  acceptsPointer: (
    event: PointerEvent,
    ctx: CanvasPointerRouterContext,
  ) => boolean;
  onTap: (nodeId: string, event: PointerEvent) => void;
  canDrag?: (node: Node) => boolean;
  onActiveChange?: (active: boolean) => void;
}): PointerRecognizer<PointerEvent, CanvasPointerRouterContext> {
  let pointerId: number | null = null;
  let canvasId: string | null = null;
  let startClient = { x: 0, y: 0 };
  let startFlow = { x: 0, y: 0 };
  let locked = false;
  let activationDistance = getDragActivationDistance('touch');
  let movementAllowed = true;
  let gestureIds: string[] = [];
  let primaryNode: Node | null = null;
  let pressedNodeId: string | null = null;
  let draggedNodes: Node[] = [];
  let startPositions = new Map<string, { x: number; y: number }>();

  const reset = (): void => {
    if (locked) options?.onActiveChange?.(false);
    pointerId = null;
    locked = false;
    gestureIds = [];
    primaryNode = null;
    pressedNodeId = null;
    draggedNodes = [];
    startPositions = new Map();
  };

  const cancelDrag = (): void => {
    if (
      locked &&
      movementAllowed &&
      primaryNode &&
      useCanvasStore.getState().canvasId === canvasId
    ) {
      useCanvasStore.getState().cancelActiveNodeDrag();
    }
    reset();
  };

  /** Node id under the point iff it exists AND is currently selected. */
  const selectedNodeIdAt = (event: PointerEvent): string | null => {
    const sketchNodeIds = new Set(
      useCanvasStore
        .getState()
        .nodes.filter(
          (node) => event.pointerType === 'touch' && node.type === 'sketch',
        )
        .map((node) => node.id),
    );
    const id = nodeIdAtScreenPoint(event.clientX, event.clientY, {
      excludeNodeIds: sketchNodeIds,
    });
    if (
      event.target instanceof Element &&
      event.target.closest('.react-flow__nodesselection-rect')
    ) {
      return (
        useCanvasStore
          .getState()
          .nodes.find(
            (node) =>
              node.selected &&
              !node.data.locked &&
              node.draggable !== false &&
              !sketchNodeIds.has(node.id),
          )?.id ?? null
      );
    }
    if (!id) return null;
    const node = useCanvasStore.getState().nodes.find((n) => n.id === id);
    return node?.selected ? id : null;
  };

  const positionChanges = (
    dx: number,
    dy: number,
    dragging: boolean,
  ): NodeChange[] =>
    gestureIds.map((id) => {
      const start = startPositions.get(id) ?? { x: 0, y: 0 };
      return {
        type: 'position',
        id,
        position: { x: start.x + dx, y: start.y + dy },
        dragging,
      };
    });

  const flowDelta = (
    ctx: CanvasPointerRouterContext,
    clientX: number,
    clientY: number,
  ): { dx: number; dy: number } => {
    const curFlow = ctx.instance.screenToFlowPosition({
      x: clientX,
      y: clientY,
    });
    return { dx: curFlow.x - startFlow.x, dy: curFlow.y - startFlow.y };
  };

  return {
    id: 'node-drag',
    canClaim: (event, ctx) =>
      pointerId === null &&
      !useInkSigilStore.getState().pending &&
      (options
        ? options.acceptsPointer(event, ctx)
        : event.pointerType === 'touch' && ctx.inputMode === 'pen') &&
      event.isPrimary &&
      !isPanelTarget(event.target as Element | null) &&
      !isNodeControlTarget(event.target as Element | null) &&
      selectedNodeIdAt(event) !== null,
    onDown: (event, ctx) => {
      const primaryId = selectedNodeIdAt(event);
      if (!primaryId) return 'pass';
      // Drag the whole current selection; the pressed node is guaranteed
      // to be one of the selected set by `canClaim`.
      const nodes = useCanvasStore.getState().nodes;
      canvasId = useCanvasStore.getState().canvasId;
      const selected = getFrameDragRoots(
        nodes,
        nodes.filter(
          (n) =>
            n.selected &&
            !n.data.locked &&
            n.draggable !== false &&
            (event.pointerType !== 'touch' || n.type !== 'sketch'),
        ),
      );
      pressedNodeId = primaryId;
      gestureIds = selected.map((n) => n.id);
      draggedNodes = selected;
      const primaryIds = new Set([
        primaryId,
        ...getAncestorIds(indexById(nodes), primaryId),
      ]);
      primaryNode =
        selected.find((n) => primaryIds.has(n.id)) ?? selected[0] ?? null;
      const pressedNode = nodes.find((node) => node.id === primaryId);
      movementAllowed = Boolean(
        primaryNode &&
        pressedNode &&
        !pressedNode.data.locked &&
        pressedNode.draggable !== false &&
        (options?.canDrag?.(primaryNode) ?? true),
      );
      startPositions = new Map(
        selected.map((n) => [n.id, { x: n.position.x, y: n.position.y }]),
      );
      pointerId = event.pointerId;
      activationDistance = getDragActivationDistance(event.pointerType);
      startClient = { x: event.clientX, y: event.clientY };
      startFlow = ctx.instance.screenToFlowPosition(startClient);
      locked = false;
      event.preventDefault();
      event.stopPropagation();
      return 'claim';
    },
    onMove: (event, ctx) => {
      if (event.pointerId !== pointerId) return;
      if (useCanvasStore.getState().canvasId !== canvasId) return reset();
      event.preventDefault();
      event.stopPropagation();
      if (!locked) {
        const moved = Math.hypot(
          event.clientX - startClient.x,
          event.clientY - startClient.y,
        );
        if (moved < activationDistance) return;
        locked = true;
        options?.onActiveChange?.(true);
        // Snapshots pre-drag positions + begins the snap session (same
        // as a mouse/pen drag start).
        if (movementAllowed && primaryNode) {
          useCanvasStore
            .getState()
            .onNodeDragStart(event, primaryNode, draggedNodes);
        }
      }
      if (!movementAllowed) return;
      const { dx, dy } = flowDelta(ctx, event.clientX, event.clientY);
      const store = useCanvasStore.getState();
      store.onNodesChange(positionChanges(dx, dy, true));
      const liveDragged = draggedNodes.map((node) => ({
        ...node,
        position: { x: node.position.x + dx, y: node.position.y + dy },
      }));
      const livePrimary = liveDragged.find(
        (node) => node.id === primaryNode?.id,
      );
      if (livePrimary) {
        store.onNodeDrag(event, livePrimary, liveDragged);
      }
    },
    onUp: (event, ctx) => {
      if (event.pointerId !== pointerId) return;
      if (useCanvasStore.getState().canvasId !== canvasId) return reset();
      event.preventDefault();
      event.stopPropagation();
      if (locked && movementAllowed && primaryNode) {
        const { dx, dy } = flowDelta(ctx, event.clientX, event.clientY);
        const store = useCanvasStore.getState();
        // Final `dragging:false` commit ends the snap session; then the
        // stop handler resolves frame re-parenting, schedules the save,
        // and keeps or rolls back the single undo entry.
        store.onNodesChange(positionChanges(dx, dy, false));
        store.onNodeDragStop(event, primaryNode, draggedNodes);
      } else if (
        !locked &&
        pressedNodeId &&
        Math.hypot(
          event.clientX - startClient.x,
          event.clientY - startClient.y,
        ) < activationDistance
      ) {
        options?.onTap(pressedNodeId, event);
      }
      reset();
    },
    onCancel: (event) => {
      if (event.pointerId !== pointerId) return;
      // Cancellation is not a drop: restore the pre-drag positions, clear
      // `dragging`, and tear down snap/history state without running frame
      // re-parenting or scheduling a save.
      cancelDrag();
    },
  };
}
