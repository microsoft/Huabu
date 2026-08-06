// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useReactFlow } from '@xyflow/react';
import { useCallback, useRef } from 'react';

import { getDragActivationDistance } from '@/handler/canvasGestureSession';
import useCanvasStore from '@/store/canvasStore';

import type { Node, NodeChange } from '@xyflow/react';
import type { MouseEvent as ReactMouseEvent, PointerEvent } from 'react';

interface DragState {
  pointerId: number | null;
  startClient: { x: number; y: number };
  startPositions: Map<string, { x: number; y: number }>;
  gestureIds: string[];
  primaryNode: Node | null;
  draggedNodes: Node[];
  /** Movement crossed the activation distance → this is a drag, not a click. */
  locked: boolean;
}

/**
 * Drag support for the zoom takeover mark.
 *
 * When a Question node collapses, its readable card is hidden and a
 * screen-space mark (rendered in `NodeTakeoverLayer`'s portal) stands in
 * for it. That portal lives outside the React Flow node subtree, so React
 * Flow's own pointer drag never sees the press and the collapsed node
 * cannot be moved — while the mark's click still opens the conversation.
 *
 * This hook re-adds drag by driving the store's existing drag lifecycle
 * (`onNodeDragStart` → `onNodesChange` position ticks → `onNodeDragStop`),
 * exactly like the Sketch `node-drag` recognizer, so smart-snap, frame
 * re-parenting, autosave, and single-entry undo stay identical to a native
 * drag. Click-vs-drag is disambiguated by the shared activation distance:
 * a press that never moves far enough falls through as a plain click (the
 * mark opens the conversation); a press that does is a drag and the trailing
 * click is swallowed via `onClickCapture` so the two never conflict.
 */
export function useTakeoverMarkDrag(nodeId: string): {
  onPointerDown: (event: PointerEvent) => void;
  onPointerMove: (event: PointerEvent) => void;
  onPointerUp: (event: PointerEvent) => void;
  onPointerCancel: (event: PointerEvent) => void;
  onClickCapture: (event: ReactMouseEvent) => void;
} {
  const { screenToFlowPosition } = useReactFlow();
  const stateRef = useRef<DragState>({
    pointerId: null,
    startClient: { x: 0, y: 0 },
    startPositions: new Map(),
    gestureIds: [],
    primaryNode: null,
    draggedNodes: [],
    locked: false,
  });
  // A drag just finished, so the browser-synthesised click that follows must
  // not reach the mark's open handler.
  const suppressClickRef = useRef(false);

  // The store's drag callbacks are typed as DOM mouse handlers; synthesize the
  // only fields they read (`altKey` for snap Alt-bypass, `clientX`/`clientY`
  // for the drop's reparent grid column).
  const dragEvent = (extra?: {
    clientX: number;
    clientY: number;
  }): MouseEvent => ({ altKey: false, ...extra }) as unknown as MouseEvent;

  const positionChanges = useCallback(
    (dx: number, dy: number, dragging: boolean): NodeChange[] => {
      const s = stateRef.current;
      return s.gestureIds.map((id) => {
        const start = s.startPositions.get(id) ?? { x: 0, y: 0 };
        return {
          type: 'position',
          id,
          position: { x: start.x + dx, y: start.y + dy },
          dragging,
        };
      });
    },
    [],
  );

  const flowDelta = useCallback(
    (clientX: number, clientY: number): { dx: number; dy: number } => {
      const start = screenToFlowPosition(stateRef.current.startClient);
      const cur = screenToFlowPosition({ x: clientX, y: clientY });
      return { dx: cur.x - start.x, dy: cur.y - start.y };
    },
    [screenToFlowPosition],
  );

  const reset = (): void => {
    const s = stateRef.current;
    s.pointerId = null;
    s.locked = false;
    s.gestureIds = [];
    s.primaryNode = null;
    s.draggedNodes = [];
    s.startPositions = new Map();
  };

  const onPointerDown = useCallback(
    (event: PointerEvent): void => {
      if (!event.isPrimary || event.button !== 0) return;
      const store = useCanvasStore.getState();
      const node = store.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      // Drag the whole current selection when this node is part of it,
      // otherwise move just this node (without altering selection).
      const selected = node.selected
        ? (store.nodes.filter((n) => n.selected) as Node[])
        : [node as Node];
      const s = stateRef.current;
      s.gestureIds = selected.map((n) => n.id);
      s.draggedNodes = selected;
      s.primaryNode = selected.find((n) => n.id === nodeId) ?? (node as Node);
      s.startPositions = new Map(
        selected.map((n) => [n.id, { x: n.position.x, y: n.position.y }]),
      );
      s.pointerId = event.pointerId;
      s.startClient = { x: event.clientX, y: event.clientY };
      s.locked = false;
      suppressClickRef.current = false;
      event.currentTarget.setPointerCapture(event.pointerId);
      // Keep the press from reaching the pane (pan / deselect).
      event.stopPropagation();
    },
    [nodeId],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent): void => {
      const s = stateRef.current;
      if (event.pointerId !== s.pointerId) return;
      if (!s.locked) {
        const moved = Math.hypot(
          event.clientX - s.startClient.x,
          event.clientY - s.startClient.y,
        );
        if (moved < getDragActivationDistance(event.pointerType)) return;
        s.locked = true;
        if (s.primaryNode) {
          useCanvasStore
            .getState()
            .onNodeDragStart(dragEvent(), s.primaryNode, s.draggedNodes);
        }
      }
      event.stopPropagation();
      const { dx, dy } = flowDelta(event.clientX, event.clientY);
      useCanvasStore.getState().onNodesChange(positionChanges(dx, dy, true));
    },
    [flowDelta, positionChanges],
  );

  const onPointerUp = useCallback(
    (event: PointerEvent): void => {
      const s = stateRef.current;
      if (event.pointerId !== s.pointerId) return;
      if (s.locked && s.primaryNode) {
        event.stopPropagation();
        const { dx, dy } = flowDelta(event.clientX, event.clientY);
        const store = useCanvasStore.getState();
        store.onNodesChange(positionChanges(dx, dy, false));
        store.onNodeDragStop(
          dragEvent({ clientX: event.clientX, clientY: event.clientY }),
          s.primaryNode,
          s.draggedNodes,
        );
        // Swallow the click that the browser fires after this drag so the
        // mark does not also open the conversation.
        suppressClickRef.current = true;
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      reset();
    },
    [flowDelta, positionChanges],
  );

  const onPointerCancel = useCallback((event: PointerEvent): void => {
    const s = stateRef.current;
    if (event.pointerId !== s.pointerId) return;
    if (s.locked && s.primaryNode) {
      useCanvasStore.getState().cancelActiveNodeDrag();
    }
    reset();
  }, []);

  const onClickCapture = useCallback((event: ReactMouseEvent): void => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onClickCapture,
  };
}
