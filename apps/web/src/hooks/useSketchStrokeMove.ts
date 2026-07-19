import { useCallback, useRef } from 'react';

import { buildMoveStrokesCommands } from '@/components/Nodes/sketch/sketchMerge';
import useCanvasStore from '@/store/canvasStore';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import type { CanvasCommand, CanvasNodeId } from '@sediment/shared';
import type { ReactFlowInstance } from '@xyflow/react';
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
 * {@link buildMoveStrokesCommands} (in-node translate + bbox reflow) as one
 * undo gesture, and translate the retained polygon so it keeps surrounding
 * the strokes.
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
  } | null>(null);

  const onPointerDown = useCallback(
    (event: PointerEvent): boolean => {
      const inst = rfInstanceRef.current;
      if (!inst) return false;
      dragRef.current = {
        pointerId: event.pointerId,
        startFlow: inst.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        }),
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
      useGesturePreviewStore.getState().setSketchStrokeMovePreview({
        dx: cur.x - drag.startFlow.x,
        dy: cur.y - drag.startFlow.y,
      });
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
    if (!offset || (offset.dx === 0 && offset.dy === 0)) return;

    const selection = preview.sketchStrokeSelection;
    const commands: CanvasCommand[] = [];
    for (const [nodeId, strokeIds] of Object.entries(selection)) {
      if (strokeIds.length === 0) continue;
      commands.push(
        ...buildMoveStrokesCommands(
          nodeId as CanvasNodeId,
          new Set(strokeIds),
          offset.dx,
          offset.dy,
        ),
      );
    }

    if (commands.length > 0) {
      const store = useCanvasStore.getState();
      if (commands.some((c) => c.type === 'SET_NODE_GEOMETRY')) {
        store.beginGesture('SET_NODE_GEOMETRY');
      }
      store.executeCommands(commands, 'ui');
    }

    // Keep the retained polygon around the moved strokes.
    const poly = preview.sketchSelectionPolygon;
    if (poly) {
      preview.setSketchSelectionPolygon(
        poly.map((p) => ({ x: p.x + offset.dx, y: p.y + offset.dy })),
      );
    }
  }, []);

  const onPointerCancel = useCallback((event: PointerEvent) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    useGesturePreviewStore.getState().setSketchStrokeMovePreview(null);
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: commit,
    onPointerCancel,
  };
}
