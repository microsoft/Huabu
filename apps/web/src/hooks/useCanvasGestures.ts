// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useStoreApi, type ReactFlowInstance } from '@xyflow/react';
import { useEffect, type MutableRefObject } from 'react';

import {
  isNodeTarget,
  isPanelTarget,
} from '../components/Panels/Canvas/canvasInputPolicy';
import { MAX_ZOOM, MIN_ZOOM } from '../config/canvas';

import type { EffectiveInputMode } from '@/store/toolStore';

interface CanvasGestureOptions {
  inputMode: EffectiveInputMode;
  explicitToolActive: boolean;
  onTouchTakeover: () => void;
  onEmptyCanvasTap: () => void;
}

/**
 * Custom trackpad / multi-touch selection helpers for the canvas.
 *
 * Touch viewport navigation (single-finger pan and two-finger pinch) now
 * lives in the pointer router's `viewport-navigation` recognizer; this
 * hook retains the two remaining non-router concerns:
 *
 *  - **Trackpad pinch** (`ctrlKey + wheel`): boost the default sensitivity
 *    so Windows touchpads feel as responsive as macOS.
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

export const distance = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

export const midpoint = (a: Point, b: Point): Point => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

export function shouldOwnSingleTouchNavigation(
  target: Element | null,
  options: Pick<CanvasGestureOptions, 'inputMode' | 'explicitToolActive'>,
): boolean {
  const { inputMode, explicitToolActive } = options;
  if (inputMode === 'mouse') return false;
  if (isPanelTarget(target)) return false;
  if (inputMode === 'pen') return true;
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
