// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useReactFlow, useStoreApi } from '@xyflow/react';
import { useCallback, useEffect, useRef } from 'react';

import { canManipulateCanvasWithPointer } from '@/components/Panels/Canvas/canvasInputPolicy';
import { getDragActivationDistance } from '@/handler/canvasGestureSession';
import { canTouchClaimViewport } from '@/handler/canvasInteractionOwner';
import { readEffectiveInputMode } from '@/hooks/useInputMode';
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

export function projectTakeoverDraggedNodes(
  draggedNodes: readonly Node[],
  startPositions: ReadonlyMap<string, { x: number; y: number }>,
  dx: number,
  dy: number,
): Node[] {
  return draggedNodes.map((node) => {
    const start = startPositions.get(node.id) ?? node.position;
    return {
      ...node,
      position: { x: start.x + dx, y: start.y + dy },
    };
  });
}

/**
 * Shared portal drag support for the zoom takeover mark and toolbar grip.
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
export function useTakeoverMarkDrag(
  nodeId: string,
  options: {
    enabled?: boolean;
    soleSelectionOnly?: boolean;
    onActiveChange?: (active: boolean) => void;
  } = {},
): {
  onPointerDown: (event: PointerEvent) => void;
  onPointerMove: (event: PointerEvent) => void;
  onPointerUp: (event: PointerEvent) => void;
  onPointerCancel: (event: PointerEvent) => void;
  onLostPointerCapture: (event: PointerEvent) => void;
  onClickCapture: (event: ReactMouseEvent) => void;
} {
  const { screenToFlowPosition } = useReactFlow();
  const flowStore = useStoreApi();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const captureRef = useRef<Element | null>(null);
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
  // pointer and modifier fields consumed by snap and Frame entry policy.
  const dragEvent = (event: PointerEvent): MouseEvent =>
    ({
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      clientX: event.clientX,
      clientY: event.clientY,
    }) as unknown as MouseEvent;

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

  const projectedDrag = useCallback((dx: number, dy: number) => {
    const state = stateRef.current;
    const draggedNodes = projectTakeoverDraggedNodes(
      state.draggedNodes,
      state.startPositions,
      dx,
      dy,
    );
    const primaryNode =
      draggedNodes.find((node) => node.id === state.primaryNode?.id) ?? null;
    return { primaryNode, draggedNodes };
  }, []);

  const flowDelta = useCallback(
    (clientX: number, clientY: number): { dx: number; dy: number } => {
      const start = screenToFlowPosition(stateRef.current.startClient);
      const cur = screenToFlowPosition({ x: clientX, y: clientY });
      return { dx: cur.x - start.x, dy: cur.y - start.y };
    },
    [screenToFlowPosition],
  );

  const reset = useCallback((): void => {
    const s = stateRef.current;
    const pointerId = s.pointerId;
    const target = captureRef.current;
    captureRef.current = null;
    s.pointerId = null;
    s.locked = false;
    s.gestureIds = [];
    s.primaryNode = null;
    s.draggedNodes = [];
    s.startPositions = new Map();
    if (pointerId !== null) {
      if (target?.hasPointerCapture(pointerId))
        target.releasePointerCapture(pointerId);
      optionsRef.current.onActiveChange?.(false);
    }
  }, []);

  const cancel = useCallback(() => {
    const s = stateRef.current;
    if (s.locked && s.primaryNode) {
      useCanvasStore.getState().cancelActiveNodeDrag();
      suppressClickRef.current = true;
    }
    reset();
  }, [reset]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && stateRef.current.pointerId !== null) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    const hidden = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', keydown, true);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', keydown, true);
      document.removeEventListener('visibilitychange', hidden);
      cancel();
    };
  }, [cancel, nodeId]);

  useEffect(() => {
    if (options.enabled === false) cancel();
  }, [options.enabled, cancel]);

  const onPointerDown = useCallback(
    (event: PointerEvent): void => {
      if (
        !event.isPrimary ||
        event.button !== 0 ||
        stateRef.current.pointerId !== null ||
        optionsRef.current.enabled === false ||
        !flowStore.getState().nodesConnectable ||
        !canManipulateCanvasWithPointer(
          event.pointerType,
          readEffectiveInputMode(),
        ) ||
        !canTouchClaimViewport()
      )
        return;
      const store = useCanvasStore.getState();
      const node = store.nodes.find((n) => n.id === nodeId);
      if (!node || node.data.locked || node.draggable === false) return;
      if (
        optionsRef.current.soleSelectionOnly &&
        (!node.selected || store.nodes.filter((n) => n.selected).length !== 1)
      )
        return;
      // Drag the whole current selection when this node is part of it,
      // otherwise move just this node (without altering selection).
      const selected = node.selected
        ? (store.nodes.filter(
            (n) => n.selected && !n.data.locked && n.draggable !== false,
          ) as Node[])
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
      captureRef.current = event.currentTarget;
      event.currentTarget.setPointerCapture(event.pointerId);
      // Leave iframe/media keyboard ownership when chrome takes the gesture.
      if (event.currentTarget instanceof HTMLElement) {
        event.currentTarget.focus({ preventScroll: true });
      }
      optionsRef.current.onActiveChange?.(true);
      // Keep the press from reaching the pane (pan / deselect).
      event.stopPropagation();
      event.preventDefault();
    },
    [nodeId, flowStore],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent): void => {
      const s = stateRef.current;
      if (event.pointerId !== s.pointerId) return;
      if (
        !flowStore.getState().nodesConnectable ||
        optionsRef.current.enabled === false
      ) {
        cancel();
        return;
      }
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
            .onNodeDragStart(dragEvent(event), s.primaryNode, s.draggedNodes);
        }
      }
      event.stopPropagation();
      const { dx, dy } = flowDelta(event.clientX, event.clientY);
      const store = useCanvasStore.getState();
      store.onNodesChange(positionChanges(dx, dy, true));
      const projected = projectedDrag(dx, dy);
      if (projected.primaryNode) {
        store.onNodeDrag(
          dragEvent(event),
          projected.primaryNode,
          projected.draggedNodes,
        );
      }
    },
    [flowDelta, positionChanges, projectedDrag, flowStore, cancel],
  );

  const onPointerUp = useCallback(
    (event: PointerEvent): void => {
      const s = stateRef.current;
      if (event.pointerId !== s.pointerId) return;
      if (
        !flowStore.getState().nodesConnectable ||
        optionsRef.current.enabled === false
      ) {
        cancel();
        return;
      }
      if (s.locked && s.primaryNode) {
        event.stopPropagation();
        const { dx, dy } = flowDelta(event.clientX, event.clientY);
        const store = useCanvasStore.getState();
        store.onNodesChange(positionChanges(dx, dy, false));
        const projected = projectedDrag(dx, dy);
        if (projected.primaryNode) {
          store.onNodeDragStop(
            dragEvent(event),
            projected.primaryNode,
            projected.draggedNodes,
          );
        }
        // Swallow the click that the browser fires after this drag so the
        // mark does not also open the conversation.
        suppressClickRef.current = true;
      }
      reset();
    },
    [flowDelta, positionChanges, projectedDrag, reset, flowStore, cancel],
  );

  const onPointerCancel = useCallback(
    (event: PointerEvent): void => {
      const s = stateRef.current;
      if (event.pointerId !== s.pointerId) return;
      cancel();
    },
    [cancel],
  );

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
    onLostPointerCapture: onPointerCancel,
    onClickCapture,
  };
}
