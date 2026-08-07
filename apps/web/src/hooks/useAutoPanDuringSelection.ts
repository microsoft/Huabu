// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useStoreApi } from '@xyflow/react';
import { useEffect, useRef, type MutableRefObject } from 'react';

/**
 * Auto-pan the React Flow viewport while a selection drag is in progress and
 * the cursor approaches (or exits) the wrapper edge. Mirrors the behaviour
 * familiar from professional canvas / illustration tools: dragging a marquee or lasso
 * toward the viewport edge scrolls the canvas to reveal more content,
 * extending the selection naturally.
 *
 * Must be called inside a `<ReactFlow>` subtree so `useStoreApi` resolves.
 */

interface UseAutoPanDuringSelectionOptions {
  /**
   * True when an in-progress selection (built-in marquee or custom lasso)
   * should drive auto-pan. The hook is otherwise dormant.
   */
  active: boolean;
  wrapperRef: MutableRefObject<HTMLDivElement | null>;
  /**
   * Called after each pan tick with the screen-px delta the viewport moved.
   * Custom selection mechanisms (e.g. a lasso polygon stored in screen
   * coords) use this to keep their state anchored to flow-space rather than
   * scrolling along with the camera.
   */
  onPan?: (dx: number, dy: number) => void;
}

/** Distance (in screen px) from the wrapper edge where auto-pan starts ramping. */
const EDGE_THRESHOLD = 40;
/** Maximum pan velocity in screen px per second once the cursor is at / past the edge. */
const MAX_PAN_VELOCITY = 800;

export function useAutoPanDuringSelection({
  active,
  wrapperRef,
  onPan,
}: UseAutoPanDuringSelectionOptions): void {
  const storeApi = useStoreApi();
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  // Keep the latest callback reachable from the RAF loop without restarting
  // the effect on every parent render.
  const onPanRef = useRef(onPan);
  useEffect(() => {
    onPanRef.current = onPan;
  }, [onPan]);

  useEffect(() => {
    if (!active) return;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const tick = (ts: number) => {
      rafRef.current = null;
      const cursor = cursorRef.current;
      if (!cursor) return;

      const bounds = wrapper.getBoundingClientRect();
      const distLeft = cursor.x - bounds.left;
      const distRight = bounds.right - cursor.x;
      const distTop = cursor.y - bounds.top;
      const distBottom = bounds.bottom - cursor.y;

      // 0 inside the safe zone, ramps to 1 at the edge, stays 1 beyond.
      const edgeVelocity = (dist: number) => {
        if (dist >= EDGE_THRESHOLD) return 0;
        return Math.min(1, (EDGE_THRESHOLD - dist) / EDGE_THRESHOLD);
      };

      const vx = edgeVelocity(distRight) - edgeVelocity(distLeft);
      const vy = edgeVelocity(distBottom) - edgeVelocity(distTop);

      if (vx === 0 && vy === 0) {
        // Cursor moved back into the safe zone — pause until the next
        // pointermove nudges us. The pointermove listener will restart the
        // loop.
        lastTsRef.current = null;
        return;
      }

      const last = lastTsRef.current;
      lastTsRef.current = ts;
      // Cap dt to handle long pauses (tab refocus, debugger) gracefully.
      const dt = last === null ? 1 / 60 : Math.min(0.1, (ts - last) / 1000);

      // Pan in the direction OPPOSITE the cursor edge: cursor at right edge
      // → content scrolls left → viewport.x decreases.
      const dx = -vx * MAX_PAN_VELOCITY * dt;
      const dy = -vy * MAX_PAN_VELOCITY * dt;

      // We bypass `rfInstance.setViewport` here because xyflow tears down
      // its d3-zoom listeners while a box selection is active
      // (`panZoom.update` calls `destroy()` whenever `userSelectionActive`
      // flips to true), which makes `setViewport` a silent no-op for the
      // store's `transform`. Writing the transform directly works for both
      // the marquee and the lasso path uniformly. `syncViewport` keeps
      // d3-zoom's internal `__zoom` aligned so the next user gesture after
      // the selection ends doesn't snap back.
      const state = storeApi.getState();
      const [tx, ty, zoom] = state.transform;
      const nextX = tx + dx;
      const nextY = ty + dy;
      storeApi.setState({ transform: [nextX, nextY, zoom] });
      state.panZoom?.syncViewport({ x: nextX, y: nextY, zoom });

      // Keep xyflow's box-selection anchor pinned to flow-space so the
      // marquee grows toward the panning direction rather than sliding with
      // the camera. (No-op when no marquee is active.)
      if (state.userSelectionActive && state.userSelectionRect) {
        const rect = state.userSelectionRect;
        const startX = rect.startX + dx;
        const startY = rect.startY + dy;
        // Eagerly recompute the rect bounds against the (stationary) cursor
        // so the marquee visibly grows the same frame we pan. xyflow's
        // selection re-evaluation still runs via the synthetic pointermove
        // below, which is what actually updates which nodes fall inside.
        // `state.domNode` is the ReactFlow wrapper — in our layout it is
        // the only flex child of `wrapperRef`, so their bounds match and
        // we reuse `bounds` to avoid a second layout read per frame.
        const mouseX = cursor.x - bounds.left;
        const mouseY = cursor.y - bounds.top;
        storeApi.setState({
          userSelectionRect: {
            startX,
            startY,
            x: Math.min(startX, mouseX),
            y: Math.min(startY, mouseY),
            width: Math.abs(mouseX - startX),
            height: Math.abs(mouseY - startY),
          },
        });
        // Dispatch a synthetic pointermove on the pane so xyflow recomputes
        // which nodes fall inside the marquee under the new transform.
        const pane = wrapper.querySelector('.react-flow__pane');
        if (pane instanceof HTMLElement) {
          pane.dispatchEvent(
            new PointerEvent('pointermove', {
              clientX: cursor.x,
              clientY: cursor.y,
              bubbles: true,
              cancelable: true,
              pointerType: 'mouse',
              isPrimary: true,
            }),
          );
        }
      }

      onPanRef.current?.(dx, dy);

      rafRef.current = requestAnimationFrame(tick);
    };

    const onPointerMove = (e: PointerEvent) => {
      cursorRef.current = { x: e.clientX, y: e.clientY };
      if (rafRef.current === null) {
        lastTsRef.current = null;
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      cursorRef.current = null;
      lastTsRef.current = null;
    };
  }, [active, wrapperRef, storeApi]);
}
