import { useStoreApi, type ReactFlowInstance } from '@xyflow/react';
import { useEffect, useRef, type MutableRefObject } from 'react';

import {
  beginCanvasGesture,
  canTouchTakeOverCanvasGesture,
  cancelPendingCanvasGesture,
  endCanvasGesture,
  updateCanvasGesture,
} from '@/handler/canvasGestureSession';
import { isSnapSessionActive } from '@/handler/snap/snapSession';

import {
  isNodeTarget,
  isPanelTarget,
} from '../components/Panels/Canvas/canvasInputPolicy';
import { MAX_ZOOM, MIN_ZOOM } from '../config/canvas';

import type {
  DeviceModePreference,
  EffectiveDeviceMode,
  EffectiveTouchInteractionMode,
} from '@/store/toolStore';

interface CanvasGestureOptions {
  deviceMode: EffectiveDeviceMode;
  deviceModePreference: DeviceModePreference;
  touchInteractionMode: EffectiveTouchInteractionMode;
  explicitToolActive: boolean;
  onTouchTakeover: () => void;
  onEmptyCanvasTap: () => void;
}

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
  options: CanvasGestureOptions,
): void {
  useTrackpadPinch(wrapperRef, rfInstanceRef);
  useTouchNavigation(wrapperRef, rfInstanceRef, options);
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
export function clampZoom(zoom: number): number {
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
export function zoomAroundPoint(
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

const distance = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

const midpoint = (a: Point, b: Point): Point => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

export function shouldOwnSingleTouchNavigation(
  target: Element | null,
  options: Pick<
    CanvasGestureOptions,
    | 'deviceMode'
    | 'deviceModePreference'
    | 'touchInteractionMode'
    | 'explicitToolActive'
  >,
): boolean {
  const {
    deviceMode,
    deviceModePreference,
    touchInteractionMode,
    explicitToolActive,
  } = options;
  if (deviceModePreference === 'desktop') return false;
  if (deviceMode !== 'touch' && deviceModePreference !== 'auto') return false;
  if (isPanelTarget(target)) return false;
  if (touchInteractionMode === 'pen') return true;
  if (explicitToolActive) return false;
  return !isNodeTarget(target);
}

export function shouldSuppressTouchEnd(
  pointerId: number,
  panTouchId: number | null,
  isPinching: boolean,
  suppressedTouchIds: ReadonlySet<number>,
): boolean {
  return (
    panTouchId === pointerId || isPinching || suppressedTouchIds.has(pointerId)
  );
}

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
function useTouchNavigation(
  wrapperRef: MutableRefObject<HTMLDivElement | null>,
  rfInstanceRef: MutableRefObject<ReactFlowInstance | null>,
  options: CanvasGestureOptions,
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    let isPinching = false;
    let startDist = 0;
    let startMidpoint: Point = { x: 0, y: 0 };
    let startViewport: Viewport = { x: 0, y: 0, zoom: 1 };
    let panTouchId: number | null = null;
    let panStart: Point = { x: 0, y: 0 };
    let panStartViewport: Viewport = { x: 0, y: 0, zoom: 1 };
    const suppressedTouchIds = new Set<number>();
    const activeTouches = new Map<number, Point>();

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      const instance = rfInstanceRef.current;
      if (!instance) return;
      const currentOptions = optionsRef.current;
      const point = { x: event.clientX, y: event.clientY };
      activeTouches.set(event.pointerId, point);

      if (
        activeTouches.size === 1 &&
        shouldOwnSingleTouchNavigation(
          event.target as Element | null,
          currentOptions,
        )
      ) {
        if (!canTouchTakeOverCanvasGesture()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        currentOptions.onTouchTakeover();
        cancelPendingCanvasGesture();
        if (!beginCanvasGesture('touch-pan', event.pointerId, 'touch', point)) {
          return;
        }
        panTouchId = event.pointerId;
        panStart = point;
        panStartViewport = instance.getViewport();
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (activeTouches.size === 2) {
        if (isSnapSessionActive() || !canTouchTakeOverCanvasGesture()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        currentOptions.onTouchTakeover();
        if (panTouchId !== null) {
          endCanvasGesture(panTouchId);
        } else {
          cancelPendingCanvasGesture();
        }
        panTouchId = null;
        isPinching = true;
        const [first, second] = Array.from(activeTouches.entries());
        startDist = distance(first[1], second[1]);
        startMidpoint = midpoint(first[1], second[1]);
        startViewport = instance.getViewport();
        suppressedTouchIds.add(first[0]);
        suppressedTouchIds.add(second[0]);
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (
        currentOptions.deviceMode === 'touch' &&
        currentOptions.touchInteractionMode === 'pen' &&
        !isPanelTarget(event.target as Element | null)
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (
        event.pointerType !== 'touch' ||
        !activeTouches.has(event.pointerId)
      ) {
        return;
      }
      const instance = rfInstanceRef.current;
      if (!instance) return;
      const point = { x: event.clientX, y: event.clientY };
      activeTouches.set(event.pointerId, point);

      if (isPinching && activeTouches.size === 2) {
        event.preventDefault();
        event.stopPropagation();
        const [first, second] = Array.from(activeTouches.values());
        const newDist = distance(first, second);
        const newMidpoint = midpoint(first, second);
        const newZoom = clampZoom(
          startViewport.zoom * (newDist / Math.max(startDist, 1)),
        );
        const rect = el.getBoundingClientRect();
        instance.setViewport(
          zoomAroundPoint(
            startViewport,
            {
              x: startMidpoint.x - rect.left,
              y: startMidpoint.y - rect.top,
            },
            newZoom,
            {
              x: newMidpoint.x - startMidpoint.x,
              y: newMidpoint.y - startMidpoint.y,
            },
          ),
          { duration: 0 },
        );
        return;
      }

      if (panTouchId === event.pointerId && activeTouches.size === 1) {
        event.preventDefault();
        event.stopPropagation();
        if (updateCanvasGesture(event.pointerId, point) !== 'locked') return;
        instance.setViewport(
          {
            x: panStartViewport.x + point.x - panStart.x,
            y: panStartViewport.y + point.y - panStart.y,
            zoom: panStartViewport.zoom,
          },
          { duration: 0 },
        );
      } else if (isPinching && suppressedTouchIds.has(event.pointerId)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    const onPointerEnd = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      if (
        shouldSuppressTouchEnd(
          event.pointerId,
          panTouchId,
          isPinching,
          suppressedTouchIds,
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
      activeTouches.delete(event.pointerId);
      if (panTouchId === event.pointerId) {
        const phase = updateCanvasGesture(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
        });
        endCanvasGesture(event.pointerId);
        panTouchId = null;
        if (phase === 'pending') {
          optionsRef.current.onEmptyCanvasTap();
        }
      }
      if (isPinching && activeTouches.size === 0) {
        isPinching = false;
        suppressedTouchIds.clear();
      }
    };

    el.addEventListener('pointerdown', onPointerDown, { capture: true });
    el.addEventListener('pointermove', onPointerMove, { capture: true });
    el.addEventListener('pointerup', onPointerEnd, { capture: true });
    el.addEventListener('pointercancel', onPointerEnd, { capture: true });

    return () => {
      el.removeEventListener('pointerdown', onPointerDown, { capture: true });
      el.removeEventListener('pointermove', onPointerMove, { capture: true });
      el.removeEventListener('pointerup', onPointerEnd, { capture: true });
      el.removeEventListener('pointercancel', onPointerEnd, { capture: true });
    };
  }, [rfInstanceRef, wrapperRef]);
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
