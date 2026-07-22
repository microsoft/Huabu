import { useStoreApi, type ReactFlowInstance } from '@xyflow/react';
import { useEffect, type MutableRefObject } from 'react';

import { MAX_ZOOM, MIN_ZOOM } from '../config/canvas';

/**
 * Custom touch / trackpad gesture handling for the canvas.
 *
 * React Flow's built-in pinch handling is implemented via d3-zoom, whose
 * event filter rejects all `touchstart` events when `panOnDrag={false}` —
 * which is exactly what selection mode needs. To support both single-finger
 * box-selection and two-finger pinch on touch devices, we bypass d3-zoom
 * for both gestures and drive the React Flow viewport directly.
 *
 * This hook owns three concerns:
 *
 *  - **Trackpad pinch** (`ctrlKey + wheel`): boost the default sensitivity
 *    so Windows touchpads feel as responsive as macOS.
 *  - **Touch pinch + pan** (two fingers): zoom anchored on the initial
 *    midpoint, with the midpoint delta added as a pan offset.
 *  - **Multi-touch selection cancel**: when a second finger lands while a
 *    single-finger selection-rect drag is in progress, reset the selection
 *    state directly through React Flow's store (avoiding synthesized
 *    pointer events that would confuse d3-zoom).
 *
 * Must be called from inside `<ReactFlow>` so `useStoreApi` finds context.
 */
export function useCanvasGestures(
  wrapperRef: MutableRefObject<HTMLDivElement | null>,
  rfInstanceRef: MutableRefObject<ReactFlowInstance | null>,
): void {
  useTrackpadPinch(wrapperRef, rfInstanceRef);
  useTouchPinch(wrapperRef, rfInstanceRef);
  useMultiTouchSelectionCancel();
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

interface Point {
  x: number;
  y: number;
}

/** Clamp `zoom` to the configured viewport range. */
function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * Compute a new viewport that zooms `from` to `newZoom` while keeping
 * `anchor` (in wrapper-relative screen coordinates) stationary, then
 * applies an optional pan offset.
 *
 * The math: the flow-space point under `anchor` is `(anchor − from.translate) / from.zoom`.
 * To keep that point under the same screen position after zooming we offset
 * the new translate so the relation still holds at `newZoom`.
 */
function zoomAroundPoint(
  from: Viewport,
  anchor: Point,
  newZoom: number,
  pan: Point = { x: 0, y: 0 },
): Viewport {
  const flowX = (anchor.x - from.x) / from.zoom;
  const flowY = (anchor.y - from.y) / from.zoom;
  return {
    x: anchor.x - flowX * newZoom + pan.x,
    y: anchor.y - flowY * newZoom + pan.y,
    zoom: newZoom,
  };
}

const distance = (a: Touch, b: Touch): number =>
  Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

const midpoint = (a: Touch, b: Touch): Point => ({
  x: (a.clientX + b.clientX) / 2,
  y: (a.clientY + b.clientY) / 2,
});

// ---------------------------------------------------------------------------
// Trackpad pinch (ctrlKey + wheel)
// ---------------------------------------------------------------------------

const TRACKPAD_ZOOM_SENSITIVITY = 0.02;
const MAX_WHEEL_ZOOM_DELTA = 10;

/** Convert a wheel delta to a bounded multiplicative zoom factor. */
export function wheelDeltaToZoomFactor(deltaY: number): number {
  const boundedDelta =
    Math.sign(deltaY) * Math.min(Math.abs(deltaY), MAX_WHEEL_ZOOM_DELTA);
  return Math.pow(2, -boundedDelta * TRACKPAD_ZOOM_SENSITIVITY);
}

/**
 * Boost trackpad pinch-to-zoom sensitivity.
 *
 * Windows touchpads emit `ctrlKey + wheel` events with very small `deltaY`
 * values, resulting in sluggish zoom under d3-zoom's default sensitivity
 * (0.002). We intercept these in the capture phase and apply a 10× factor,
 * zooming towards the cursor. Large discrete mouse-wheel deltas are capped so
 * one notch cannot cause an abrupt multi-fold zoom jump.
 */
function useTrackpadPinch(
  wrapperRef: MutableRefObject<HTMLDivElement | null>,
  rfInstanceRef: MutableRefObject<ReactFlowInstance | null>,
): void {
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      const instance = rfInstanceRef.current;
      if (!instance) return;

      const viewport = instance.getViewport();
      const factor = wheelDeltaToZoomFactor(e.deltaY);
      const newZoom = clampZoom(viewport.zoom * factor);
      if (newZoom === viewport.zoom) return;

      e.preventDefault();
      e.stopPropagation();

      const rect = el.getBoundingClientRect();
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      instance.setViewport(zoomAroundPoint(viewport, anchor, newZoom), {
        duration: 0,
      });
    };

    el.addEventListener('wheel', handleWheel, {
      capture: true,
      passive: false,
    });
    return () =>
      el.removeEventListener('wheel', handleWheel, { capture: true });
  }, [wrapperRef, rfInstanceRef]);
}

// ---------------------------------------------------------------------------
// Two-finger touch pinch + pan
// ---------------------------------------------------------------------------

/**
 * Two-finger pinch + pan on touch devices.
 *
 * State is captured at the moment the second finger lands and held constant
 * for the duration of the gesture, so the user feels the canvas pivot around
 * a fixed point rather than chasing a drifting midpoint.
 */
function useTouchPinch(
  wrapperRef: MutableRefObject<HTMLDivElement | null>,
  rfInstanceRef: MutableRefObject<ReactFlowInstance | null>,
): void {
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    let isPinching = false;
    let startDist = 0;
    let startMidpoint: Point = { x: 0, y: 0 };
    let startViewport: Viewport = { x: 0, y: 0, zoom: 1 };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const instance = rfInstanceRef.current;
      if (!instance) return;
      isPinching = true;
      startDist = distance(e.touches[0], e.touches[1]);
      startMidpoint = midpoint(e.touches[0], e.touches[1]);
      startViewport = instance.getViewport();
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!isPinching || e.touches.length !== 2) return;
      const instance = rfInstanceRef.current;
      if (!instance) return;

      e.preventDefault();
      e.stopPropagation();

      const newDist = distance(e.touches[0], e.touches[1]);
      const newMidpoint = midpoint(e.touches[0], e.touches[1]);

      const scale = newDist / Math.max(startDist, 1);
      const newZoom = clampZoom(startViewport.zoom * scale);

      const rect = el.getBoundingClientRect();
      const anchor = {
        x: startMidpoint.x - rect.left,
        y: startMidpoint.y - rect.top,
      };
      const pan = {
        x: newMidpoint.x - startMidpoint.x,
        y: newMidpoint.y - startMidpoint.y,
      };

      instance.setViewport(
        zoomAroundPoint(startViewport, anchor, newZoom, pan),
        { duration: 0 },
      );
    };

    const endPinch = (e: TouchEvent) => {
      if (e.touches.length < 2) isPinching = false;
    };

    el.addEventListener('touchstart', onTouchStart, {
      capture: true,
      passive: true,
    });
    el.addEventListener('touchmove', onTouchMove, {
      capture: true,
      passive: false,
    });
    el.addEventListener('touchend', endPinch, { capture: true, passive: true });
    el.addEventListener('touchcancel', endPinch, {
      capture: true,
      passive: true,
    });

    return () => {
      el.removeEventListener('touchstart', onTouchStart, { capture: true });
      el.removeEventListener('touchmove', onTouchMove, { capture: true });
      el.removeEventListener('touchend', endPinch, { capture: true });
      el.removeEventListener('touchcancel', endPinch, { capture: true });
    };
  }, [wrapperRef, rfInstanceRef]);
}

// ---------------------------------------------------------------------------
// Multi-touch selection cancellation
// ---------------------------------------------------------------------------

/**
 * When a second finger lands while a single-finger selection-rect drag is
 * in progress, end the selection so the pinch handler above can take over
 * cleanly. We mutate React Flow's store directly because synthesizing a
 * `pointerup` would also kill d3-zoom's tracking on the same gesture.
 */
function useMultiTouchSelectionCancel(): void {
  const store = useStoreApi();

  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length < 2) return;
      const { userSelectionRect, userSelectionActive } = store.getState();
      if (!userSelectionRect && !userSelectionActive) return;
      store.setState({
        userSelectionActive: false,
        userSelectionRect: null,
        nodesSelectionActive: false,
      });
    };

    document.addEventListener('touchstart', handleTouchStart, {
      capture: true,
      passive: true,
    });
    return () =>
      document.removeEventListener('touchstart', handleTouchStart, {
        capture: true,
      });
  }, [store]);
}
