// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isPanelTarget } from '@/components/Panels/Canvas/canvasInputPolicy';
import { getDragActivationDistance } from '@/handler/canvasGestureSession';
import { nodeIdAtScreenPoint } from '@/handler/canvasNodeAtPoint';
import useCanvasStore from '@/store/canvasStore';

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
 * (`onNodeDragStart` → `onNodesChange` position ticks → `onNodeDragStop`)
 * rather than React Flow's own pointer drag. That indirection is
 * deliberate: while the Sketch tool is armed React Flow node dragging is
 * disabled (`nodesDraggable={false}`) and the full-screen overlay covers
 * the nodes, so the finger never reaches React Flow at all. Re-using the
 * store methods keeps smart-snap, frame re-parenting, autosave, and
 * single-entry undo byte-for-byte identical to a mouse or pen drag — the
 * recognizer only supplies the position deltas React Flow would normally
 * emit.
 *
 * It is gated to `inputMode === 'pen'`: in Finger mode the finger under
 * the Select tool already drags selected nodes through React Flow
 * natively, and under Sketch the finger draws; in Mouse mode the pointer
 * is never touch.
 */
export function createNodeDragRecognizer(): PointerRecognizer<
  PointerEvent,
  CanvasPointerRouterContext
> {
  let pointerId: number | null = null;
  let startClient = { x: 0, y: 0 };
  let locked = false;
  let gestureIds: string[] = [];
  let primaryNode: Node | null = null;
  let draggedNodes: Node[] = [];
  let startPositions = new Map<string, { x: number; y: number }>();

  const reset = (): void => {
    pointerId = null;
    locked = false;
    gestureIds = [];
    primaryNode = null;
    draggedNodes = [];
    startPositions = new Map();
  };

  const cancelDrag = (): void => {
    if (locked && primaryNode) {
      useCanvasStore.getState().cancelActiveNodeDrag();
    }
    reset();
  };

  /** Node id under the point iff it exists AND is currently selected. */
  const selectedNodeIdAt = (event: PointerEvent): string | null => {
    const id = nodeIdAtScreenPoint(event.clientX, event.clientY);
    if (!id) return null;
    const node = useCanvasStore.getState().nodes.find((n) => n.id === id);
    return node?.selected ? id : null;
  };

  // The store's drag callbacks are typed as DOM mouse/touch handlers;
  // synthesize the only fields they read (`altKey` for snap Alt-bypass,
  // `clientX`/`clientY` for the drop's reparent grid column).
  const dragEvent = (extra?: {
    clientX: number;
    clientY: number;
  }): MouseEvent => ({ altKey: false, ...extra }) as unknown as MouseEvent;

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
    const startFlow = ctx.instance.screenToFlowPosition(startClient);
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
      !ctx.interactivityLocked &&
      event.pointerType === 'touch' &&
      ctx.inputMode === 'pen' &&
      event.isPrimary &&
      !isPanelTarget(event.target as Element | null) &&
      selectedNodeIdAt(event) !== null,
    onDown: (event) => {
      const primaryId = selectedNodeIdAt(event);
      if (!primaryId) return 'pass';
      // Drag the whole current selection; the pressed node is guaranteed
      // to be one of the selected set by `canClaim`.
      const selected = useCanvasStore
        .getState()
        .nodes.filter((n) => n.selected) as Node[];
      gestureIds = selected.map((n) => n.id);
      draggedNodes = selected;
      primaryNode =
        selected.find((n) => n.id === primaryId) ?? selected[0] ?? null;
      startPositions = new Map(
        selected.map((n) => [n.id, { x: n.position.x, y: n.position.y }]),
      );
      pointerId = event.pointerId;
      startClient = { x: event.clientX, y: event.clientY };
      locked = false;
      event.preventDefault();
      event.stopPropagation();
      return 'claim';
    },
    onMove: (event, ctx) => {
      if (event.pointerId !== pointerId) return;
      if (ctx.interactivityLocked) {
        cancelDrag();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!locked) {
        const moved = Math.hypot(
          event.clientX - startClient.x,
          event.clientY - startClient.y,
        );
        if (moved < getDragActivationDistance('touch')) return;
        locked = true;
        // Snapshots pre-drag positions + begins the snap session (same
        // as a mouse/pen drag start).
        if (primaryNode) {
          useCanvasStore
            .getState()
            .onNodeDragStart(dragEvent(), primaryNode, draggedNodes);
        }
      }
      const { dx, dy } = flowDelta(ctx, event.clientX, event.clientY);
      useCanvasStore.getState().onNodesChange(positionChanges(dx, dy, true));
    },
    onUp: (event, ctx) => {
      if (event.pointerId !== pointerId) return;
      if (ctx.interactivityLocked) {
        cancelDrag();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (locked && primaryNode) {
        const { dx, dy } = flowDelta(ctx, event.clientX, event.clientY);
        const store = useCanvasStore.getState();
        // Final `dragging:false` commit ends the snap session; then the
        // stop handler resolves frame re-parenting, schedules the save,
        // and keeps or rolls back the single undo entry.
        store.onNodesChange(positionChanges(dx, dy, false));
        store.onNodeDragStop(
          dragEvent({ clientX: event.clientX, clientY: event.clientY }),
          primaryNode,
          draggedNodes,
        );
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
