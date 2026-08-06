// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import {
  beginCanvasGesture,
  endCanvasGesture,
  updateCanvasGesture,
  type CanvasPointerType,
} from '@/handler/canvasGestureSession';
import { getEdgeIdsBetweenSelectedNodes } from '@/utils/selection';

import { isLassoStartTarget } from '../components/Panels/Canvas/canvasInputPolicy';

import type { EffectiveInputMode } from '@/store/toolStore';
import type { Edge, ReactFlowInstance } from '@xyflow/react';

type Point = {
  x: number;
  y: number;
};

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const MIN_POINT_DISTANCE = 4;
const MIN_LASSO_POINTS = 3;
const MIN_LASSO_SPAN = 10;

interface UseCanvasLassoOptions {
  active: boolean;
  wrapperRef: MutableRefObject<HTMLDivElement | null>;
  rfInstanceRef: MutableRefObject<ReactFlowInstance | null>;
  edges: Edge[];
  /**
   * Called on lasso commit (and with empty args when a fresh drag
   * clears the previous selection). `flowPolygon` is the committed lasso
   * polygon in flow-space, so the consumer can compute stroke-level hits
   * and choose stroke- vs node-selection without the hook knowing about
   * sketches.
   */
  onSelect: (nodeIds: string[], flowPolygon: Point[]) => void;
  inputMode: EffectiveInputMode;
}

interface UseCanvasLassoResult {
  pointerHandlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => boolean;
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
  };
  previewPath: string | null;
  previewNodeIds: string[];
  previewEdgeIds: string[];
  /** True while the user is actively drawing a lasso polygon. */
  isActive: boolean;
  /**
   * Translate every polygon point by `(dx, dy)` in screen px. Used by the
   * auto-pan-during-selection loop to keep the lasso anchored to flow-space
   * as the viewport scrolls under it.
   */
  shiftScreenPoints: (dx: number, dy: number) => void;
  cancel: () => void;
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function rectContainsPoint(rect: Rect, point: Point) {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function pointInPolygon(point: Point, polygon: Point[]) {
  let inside = false;

  for (
    let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index++
  ) {
    const current = polygon[index];
    const prior = polygon[previous];
    const intersects =
      current.y > point.y !== prior.y > point.y &&
      point.x <
        ((prior.x - current.x) * (point.y - current.y)) /
          (prior.y - current.y || Number.EPSILON) +
          current.x;

    if (intersects) inside = !inside;
  }

  return inside;
}

function orientation(a: Point, b: Point, c: Point) {
  return (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
}

function onSegment(a: Point, b: Point, c: Point) {
  return (
    Math.min(a.x, c.x) <= b.x &&
    b.x <= Math.max(a.x, c.x) &&
    Math.min(a.y, c.y) <= b.y &&
    b.y <= Math.max(a.y, c.y)
  );
}

function segmentsIntersect(a1: Point, a2: Point, b1: Point, b2: Point) {
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);

  if (o1 > 0 !== o2 > 0 && o3 > 0 !== o4 > 0) return true;
  if (o1 === 0 && onSegment(a1, b1, a2)) return true;
  if (o2 === 0 && onSegment(a1, b2, a2)) return true;
  if (o3 === 0 && onSegment(b1, a1, b2)) return true;
  if (o4 === 0 && onSegment(b1, a2, b2)) return true;

  return false;
}

function getRectCorners(rect: Rect): Point[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

function getPolygonEdges(points: Point[]) {
  return points.map(
    (point, index) => [point, points[(index + 1) % points.length]] as const,
  );
}

function polygonIntersectsRect(polygon: Point[], rect: Rect) {
  const corners = getRectCorners(rect);
  const rectEdges = getPolygonEdges(corners);
  const polygonEdges = getPolygonEdges(polygon);

  if (corners.some((corner) => pointInPolygon(corner, polygon))) return true;
  if (polygon.some((point) => rectContainsPoint(rect, point))) return true;

  return polygonEdges.some(([start, end]) =>
    rectEdges.some(([rectStart, rectEnd]) =>
      segmentsIntersect(start, end, rectStart, rectEnd),
    ),
  );
}

function appendPoint(points: Point[], next: Point) {
  if (points.length === 0) return [next];

  const lastPoint = points[points.length - 1];

  if (distance(lastPoint, next) >= MIN_POINT_DISTANCE) {
    return [...points, next];
  }

  if (points.length === 1) {
    return [points[0], next];
  }

  return [...points.slice(0, -1), next];
}

function hasEnoughArea(points: Point[]) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);

  return (
    Math.max(...xs) - Math.min(...xs) >= MIN_LASSO_SPAN &&
    Math.max(...ys) - Math.min(...ys) >= MIN_LASSO_SPAN
  );
}

function getNodeRect(instance: ReactFlowInstance, nodeId: string): Rect | null {
  const internalNode = instance.getInternalNode(nodeId);
  if (!internalNode || internalNode.hidden) return null;

  const width =
    internalNode.measured.width ??
    internalNode.width ??
    internalNode.initialWidth;
  const height =
    internalNode.measured.height ??
    internalNode.height ??
    internalNode.initialHeight;

  if (!width || !height) return null;

  return {
    x: internalNode.internals.positionAbsolute.x,
    y: internalNode.internals.positionAbsolute.y,
    width,
    height,
  };
}

function getSelectedNodeIdsFromFlowPolygon(
  flowPolygon: Point[],
  instance: ReactFlowInstance,
) {
  return instance
    .getNodes()
    .filter((node) => {
      const rect = getNodeRect(instance, node.id);
      return rect ? polygonIntersectsRect(flowPolygon, rect) : false;
    })
    .map((node) => node.id);
}

export function useCanvasLasso({
  active,
  wrapperRef,
  rfInstanceRef,
  edges,
  onSelect,
  inputMode,
}: UseCanvasLassoOptions): UseCanvasLassoResult {
  const [screenPoints, setScreenPoints] = useState<Point[] | null>(null);
  const pendingRef = useRef<{
    pointerId: number;
    start: Point;
    captureTarget: HTMLDivElement;
  } | null>(null);
  // Whether this drag has already cleared the previous selection. Used to
  // fire `onSelect([], [])` exactly once, from the event handler body —
  // never inside a `setScreenPoints` updater (that runs during render and
  // trips React's "setState while rendering another component" warning).
  const clearedRef = useRef(false);

  const cancel = useCallback(() => {
    const pending = pendingRef.current;
    if (pending) {
      endCanvasGesture(pending.pointerId);
      if (pending.captureTarget.hasPointerCapture(pending.pointerId)) {
        pending.captureTarget.releasePointerCapture(pending.pointerId);
      }
      pendingRef.current = null;
    }
    clearedRef.current = false;
    setScreenPoints(null);
  }, []);

  useEffect(() => {
    if (!active) cancel();
  }, [active, cancel]);

  useEffect(() => cancel, [cancel]);

  useEffect(() => {
    if (!active) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        cancel();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, cancel]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!active) return false;
      if (event.button !== 0 || !event.isPrimary) return false;
      // The mouse always draws a lasso. Non-mouse pointers are accepted only
      // when the input mode routes them to direct manipulation.
      if (
        event.pointerType !== 'mouse' &&
        (inputMode === 'mouse' ||
          (inputMode === 'pen' && event.pointerType !== 'pen') ||
          (inputMode === 'finger' && event.pointerType !== 'touch'))
      ) {
        return false;
      }
      const target = event.target as HTMLElement;

      if (!isLassoStartTarget(target)) return false;

      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);

      const start = { x: event.clientX, y: event.clientY };
      if (
        !beginCanvasGesture(
          'lasso',
          event.pointerId,
          event.pointerType as CanvasPointerType,
          start,
        )
      ) {
        event.currentTarget.releasePointerCapture(event.pointerId);
        return false;
      }
      pendingRef.current = {
        pointerId: event.pointerId,
        start,
        captureTarget: event.currentTarget,
      };
      clearedRef.current = false;
      return true;
    },
    [active, inputMode],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const pending = pendingRef.current;
      if (!pending || pending.pointerId !== event.pointerId) return;
      const nextPoint = { x: event.clientX, y: event.clientY };
      const phase = updateCanvasGesture(event.pointerId, nextPoint);
      if (phase === 'pending') return;

      // Clear the previous selection once, as the lasso actually starts
      // drawing — done here (event handler) rather than inside the
      // setScreenPoints updater to avoid a setState-during-render warning.
      if (!clearedRef.current) {
        clearedRef.current = true;
        onSelect([], []);
      }
      setScreenPoints((previous) =>
        previous
          ? appendPoint(previous, nextPoint)
          : [pending.start, nextPoint],
      );
    },
    [onSelect],
  );

  const commit = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const pending = pendingRef.current;
      if (!pending || pending.pointerId !== event.pointerId) return;

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      pendingRef.current = null;
      endCanvasGesture(event.pointerId);
      if (!screenPoints) {
        // A plain click (press-release below the lasso activation
        // distance) on an empty lasso-start target is a deselect gesture:
        // clear any retained lasso selection so tapping empty canvas
        // deselects, like the Select tool and most canvas apps. Without
        // this the only way to drop a selection was drawing a fresh empty
        // loop, which made deselecting hard.
        onSelect([], []);
        cancel();
        return;
      }

      const finalScreenPoints = appendPoint(screenPoints, {
        x: event.clientX,
        y: event.clientY,
      });
      if (
        finalScreenPoints.length >= MIN_LASSO_POINTS &&
        hasEnoughArea(finalScreenPoints)
      ) {
        const instance = rfInstanceRef.current;
        const flowPolygon = instance
          ? finalScreenPoints.map((point) =>
              instance.screenToFlowPosition(point),
            )
          : [];
        const nodeIds = instance
          ? getSelectedNodeIdsFromFlowPolygon(flowPolygon, instance)
          : [];
        onSelect(nodeIds, flowPolygon);
      }

      cancel();
    },
    [cancel, onSelect, rfInstanceRef, screenPoints],
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (pendingRef.current?.pointerId !== event.pointerId) return;
      cancel();
    },
    [cancel],
  );

  const shiftScreenPoints = useCallback((dx: number, dy: number) => {
    if (dx === 0 && dy === 0) return;
    setScreenPoints((previous) =>
      previous
        ? previous.map((point) => ({ x: point.x + dx, y: point.y + dy }))
        : previous,
    );
  }, []);

  const previewPath = useMemo(() => {
    if (!screenPoints || screenPoints.length < 2) return null;

    const bounds = wrapperRef.current?.getBoundingClientRect();
    if (!bounds) return null;

    const path = screenPoints
      .map((point, index) => {
        const x = point.x - bounds.left;
        const y = point.y - bounds.top;
        return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
      })
      .join(' ');

    return `${path} Z`;
  }, [screenPoints, wrapperRef]);

  const previewNodeIds = useMemo(() => {
    if (!screenPoints || screenPoints.length < MIN_LASSO_POINTS) return [];
    if (!hasEnoughArea(screenPoints)) return [];

    const instance = rfInstanceRef.current;
    if (!instance) return [];
    const flowPolygon = screenPoints.map((point) =>
      instance.screenToFlowPosition(point),
    );
    return getSelectedNodeIdsFromFlowPolygon(flowPolygon, instance);
  }, [rfInstanceRef, screenPoints]);

  const previewEdgeIds = useMemo(
    () => getEdgeIdsBetweenSelectedNodes(previewNodeIds, edges),
    [edges, previewNodeIds],
  );

  return {
    pointerHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: commit,
      onPointerCancel,
    },
    previewPath,
    previewNodeIds,
    previewEdgeIds,
    isActive: screenPoints !== null,
    shiftScreenPoints,
    cancel,
  };
}
