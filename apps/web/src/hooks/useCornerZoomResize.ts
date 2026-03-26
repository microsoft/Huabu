import { useCallback, useRef } from 'react';

import useCanvasStore from '@/store/canvasStore.ts';

/**
 * When the canvas has only one node, corner-handle resize gestures are
 * converted to viewport zoom (the opposite corner stays fixed on screen
 * while the grabbed corner follows the cursor). Edge-handle drags still
 * resize normally so the user can change the node's aspect ratio.
 *
 * Returns:
 * - `tryStartZoom` — call from `onResizeStart`. Returns `true` if the
 *   zoom gesture was activated (caller should skip normal resize logic).
 * - `shouldResize` — pass to `<NodeResizer>`. Returns `false` while a
 *   zoom gesture is active to block ReactFlow's built-in resize.
 */
export function useCornerZoomResize() {
  const isSingleNode = useCanvasStore((state) => state.nodes.length === 1);

  const zoomResizeRef = useRef<{
    anchorScreenX: number;
    anchorScreenY: number;
    anchorFlowX: number;
    anchorFlowY: number;
    diagDirX: number;
    diagDirY: number;
    diagFlowLen: number;
    /** Constant offset = initial cursor projection − handle projection,
     *  subtracted each frame so the handle tracks cursor 1:1. */
    projectionOffset: number;
  } | null>(null);

  const tryStartZoom = useCallback(
    (
      event: unknown,
      params: { x: number; y: number; width: number; height: number },
    ): boolean => {
      if (!isSingleNode) return false;

      const sourceEvent = (event as { sourceEvent?: PointerEvent })
        ?.sourceEvent;
      const target = sourceEvent?.target;

      // Edge handles (the "line" variant) still allow normal resize so
      // the user can change the node's aspect ratio. Only corner handles
      // ("handle" variant) are converted to zoom.
      const isEdgeHandle =
        target instanceof HTMLElement && target.classList.contains('line');

      if (isEdgeHandle || !sourceEvent) return false;

      const rfInstance = useCanvasStore.getState().rfInstance;
      if (!rfInstance) return false;

      const vp = rfInstance.getViewport();

      // Determine which corner the user grabbed by finding the
      // closest node corner to the cursor in flow space.
      const corners = [
        { fx: params.x, fy: params.y }, // top-left
        { fx: params.x + params.width, fy: params.y }, // top-right
        { fx: params.x, fy: params.y + params.height }, // bottom-left
        { fx: params.x + params.width, fy: params.y + params.height }, // bottom-right
      ];

      const cursorFlowX = (sourceEvent.clientX - vp.x) / vp.zoom;
      const cursorFlowY = (sourceEvent.clientY - vp.y) / vp.zoom;

      let closestIdx = 0;
      let minDist = Infinity;
      corners.forEach((c, i) => {
        const d = Math.hypot(c.fx - cursorFlowX, c.fy - cursorFlowY);
        if (d < minDist) {
          minDist = d;
          closestIdx = i;
        }
      });

      // The opposite corner acts as the anchor — it stays fixed on
      // screen while the grabbed corner follows the cursor.
      const opposite = corners[3 - closestIdx];
      const anchorScreenX = opposite.fx * vp.zoom + vp.x;
      const anchorScreenY = opposite.fy * vp.zoom + vp.y;

      // Diagonal vector in flow space (from anchor to grabbed corner).
      const diagFlowX = corners[closestIdx].fx - opposite.fx;
      const diagFlowY = corners[closestIdx].fy - opposite.fy;
      const diagFlowLen = Math.hypot(diagFlowX, diagFlowY);
      const diagDirX = diagFlowX / diagFlowLen;
      const diagDirY = diagFlowY / diagFlowLen;

      // The handle's true screen projection from anchor = diagFlowLen * zoom.
      // The cursor's projection may differ by a few pixels (handle has 8×8 size).
      // Record this constant offset so we can subtract it each frame,
      // giving 1:1 tracking with no initial jump.
      const initScreenDx = sourceEvent.clientX - anchorScreenX;
      const initScreenDy = sourceEvent.clientY - anchorScreenY;
      const cursorProjection =
        initScreenDx * diagDirX + initScreenDy * diagDirY;
      const handleProjection = diagFlowLen * vp.zoom;
      const projectionOffset = cursorProjection - handleProjection;

      zoomResizeRef.current = {
        anchorScreenX,
        anchorScreenY,
        anchorFlowX: opposite.fx,
        anchorFlowY: opposite.fy,
        diagDirX,
        diagDirY,
        diagFlowLen,
        projectionOffset,
      };

      // Drive zoom from raw screen-space pointer position.
      // Project the cursor–anchor screen vector onto the diagonal
      // direction so the grabbed corner tracks the cursor.
      const onPointerMove = (e: PointerEvent) => {
        const initial = zoomResizeRef.current;
        if (!initial) return;

        const screenDx = e.clientX - initial.anchorScreenX;
        const screenDy = e.clientY - initial.anchorScreenY;
        const projectedLen =
          screenDx * initial.diagDirX + screenDy * initial.diagDirY;

        const newZoom = Math.max(
          0.1,
          Math.min(
            5,
            (projectedLen - initial.projectionOffset) / initial.diagFlowLen,
          ),
        );

        // Apply viewport synchronously so the handle stays under the
        // cursor with zero frame delay.
        const inst = useCanvasStore.getState().rfInstance;
        inst?.setViewport(
          {
            x: initial.anchorScreenX - initial.anchorFlowX * newZoom,
            y: initial.anchorScreenY - initial.anchorFlowY * newZoom,
            zoom: newZoom,
          },
          { duration: 0 },
        );
      };

      const cleanup = () => {
        zoomResizeRef.current = null;
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', cleanup);
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', cleanup);
      return true;
    },
    [isSingleNode],
  );

  // Block ReactFlow's built-in resize when a corner-handle zoom gesture is
  // active. The actual zoom is driven by the raw pointermove listener above.
  const shouldResize = useCallback((): boolean => !zoomResizeRef.current, []);

  return { tryStartZoom, shouldResize };
}
