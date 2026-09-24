// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useStoreApi } from '@xyflow/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { isLassoStartTarget } from '@/components/Panels/Canvas/canvasInputPolicy';
import {
  beginCanvasGesture,
  endCanvasGesture,
  updateCanvasGesture,
  type CanvasPointerType,
} from '@/handler/canvasGestureSession';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import { createAreaSelectionSession } from './areaSelectionSession';
import { useAreaSelectionClickGuard } from './useAreaSelectionClickGuard';

import type { EffectiveInputMode } from '@/store/toolStore';
import type { SelectionArea } from '@/utils/selectionGeometry';
import type { ReactFlowInstance, XYPosition } from '@xyflow/react';

const MIN_POINT_DISTANCE = 4;
const MIN_LASSO_POINTS = 3;
const MIN_LASSO_SPAN = 10;

interface UseCanvasLassoOptions {
  active: boolean;
  scopeKey: string | null;
  wrapperRef: MutableRefObject<HTMLDivElement | null>;
  rfInstanceRef: MutableRefObject<ReactFlowInstance | null>;
  inputMode: EffectiveInputMode;
}

function appendPoint(points: XYPosition[], next: XYPosition) {
  if (points.length === 0) return [next];
  const last = points[points.length - 1];
  if (Math.hypot(last.x - next.x, last.y - next.y) >= MIN_POINT_DISTANCE) {
    return [...points, next];
  }
  return points.length === 1
    ? [points[0], next]
    : [...points.slice(0, -1), next];
}

function hasEnoughArea(points: XYPosition[]) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return (
    Math.max(...xs) - Math.min(...xs) >= MIN_LASSO_SPAN &&
    Math.max(...ys) - Math.min(...ys) >= MIN_LASSO_SPAN
  );
}

export function useCanvasLasso({
  active,
  scopeKey,
  wrapperRef,
  rfInstanceRef,
  inputMode,
}: UseCanvasLassoOptions) {
  const flowStore = useStoreApi();
  const suppressClick = useAreaSelectionClickGuard(wrapperRef, scopeKey);
  const [screenPoints, setScreenPoints] = useState<XYPosition[] | null>(null);
  // Pointerup and auto-pan must see the last event even before React renders.
  const pointsRef = useRef<XYPosition[] | null>(null);
  const optionsRef = useRef({ active, scopeKey });
  optionsRef.current = { active, scopeKey };
  const pendingRef = useRef<{
    pointerId: number;
    start: XYPosition;
    captureTarget: HTMLDivElement;
    scopeKey: string | null;
    selection: ReturnType<typeof createAreaSelectionSession>;
    nodesSelectionActive: boolean;
  } | null>(null);

  const finish = useCallback(
    (cancelled: boolean) => {
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) {
        if (cancelled && pending.scopeKey === optionsRef.current.scopeKey) {
          pending.selection.cancel();
        }
        endCanvasGesture(pending.pointerId);
        flowStore.setState({
          userSelectionActive: false,
          nodesSelectionActive:
            cancelled && pending.scopeKey === optionsRef.current.scopeKey
              ? pending.nodesSelectionActive
              : false,
        });
        if (pending.captureTarget.hasPointerCapture(pending.pointerId)) {
          pending.captureTarget.releasePointerCapture(pending.pointerId);
        }
      }
      pointsRef.current = null;
      setScreenPoints(null);
    },
    [flowStore],
  );
  const cancel = useCallback(() => finish(true), [finish]);

  const selectionArea = useCallback(
    (points: XYPosition[]): SelectionArea | null => {
      const instance = rfInstanceRef.current;
      if (
        !instance ||
        points.length < MIN_LASSO_POINTS ||
        !hasEnoughArea(points)
      )
        return null;
      return {
        kind: 'polygon',
        points: points.map((point) =>
          instance.screenToFlowPosition(point, { snapToGrid: false }),
        ),
      };
    },
    [rfInstanceRef],
  );

  useEffect(() => {
    if (!active) cancel();
  }, [active, cancel]);
  useEffect(() => cancel, [cancel, scopeKey]);
  useEffect(() => {
    if (!active) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !pendingRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    const hidden = () => {
      if (document.hidden) cancel();
    };
    const lostCapture = (event: PointerEvent) => {
      if (event.pointerId === pendingRef.current?.pointerId) cancel();
    };
    const wrapper = wrapperRef.current;
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', hidden);
    wrapper?.addEventListener('lostpointercapture', lostCapture);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', hidden);
      wrapper?.removeEventListener('lostpointercapture', lostCapture);
    };
  }, [active, cancel, wrapperRef]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!active || useGesturePreviewStore.getState().inkSubmissionPreparing)
        return false;
      if (event.button !== 0 || !event.isPrimary) return false;
      if (
        event.pointerType !== 'mouse' &&
        (inputMode === 'mouse' ||
          (inputMode === 'pen' && event.pointerType !== 'pen') ||
          (inputMode === 'finger' && event.pointerType !== 'touch'))
      )
        return false;
      if (!isLassoStartTarget(event.target as HTMLElement)) return false;
      const start = { x: event.clientX, y: event.clientY };
      if (
        !beginCanvasGesture(
          'lasso',
          event.pointerId,
          event.pointerType as CanvasPointerType,
          start,
        )
      ) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus({ preventScroll: true });
      suppressClick();
      pendingRef.current = {
        pointerId: event.pointerId,
        start,
        captureTarget: event.currentTarget,
        scopeKey,
        selection: createAreaSelectionSession(true),
        nodesSelectionActive: flowStore.getState().nodesSelectionActive,
      };
      return true;
    },
    [active, flowStore, inputMode, scopeKey, suppressClick],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const pending = pendingRef.current;
      if (!pending || pending.pointerId !== event.pointerId) return;
      if (!optionsRef.current.active || !(event.buttons & 1)) {
        cancel();
        return;
      }
      const next = { x: event.clientX, y: event.clientY };
      if (updateCanvasGesture(event.pointerId, next) !== 'locked') return;
      if (!pointsRef.current) {
        flowStore.setState({
          userSelectionActive: true,
          nodesSelectionActive: false,
        });
      }
      const points = pointsRef.current
        ? appendPoint(pointsRef.current, next)
        : [pending.start, next];
      pointsRef.current = points;
      setScreenPoints(points);
      pending.selection.preview(selectionArea(points));
    },
    [cancel, flowStore, selectionArea],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const pending = pendingRef.current;
      if (
        !pending ||
        pending.pointerId !== event.pointerId ||
        event.button !== 0
      )
        return;
      if (
        !optionsRef.current.active ||
        pending.scopeKey !== optionsRef.current.scopeKey
      ) {
        cancel();
        return;
      }
      const points = pointsRef.current;
      const finalPoints = points
        ? appendPoint(points, { x: event.clientX, y: event.clientY })
        : [];
      pending.selection.commit(selectionArea(finalPoints));
      finish(false);
    },
    [cancel, finish, selectionArea],
  );
  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (pendingRef.current?.pointerId === event.pointerId) cancel();
    },
    [cancel],
  );

  const shiftScreenPoints = useCallback(
    (dx: number, dy: number) => {
      if (dx === 0 && dy === 0) return;
      const points = pointsRef.current;
      if (!points) return;
      const shifted = points.map((point) => ({
        x: point.x + dx,
        y: point.y + dy,
      }));
      pointsRef.current = shifted;
      setScreenPoints(shifted);
      pendingRef.current?.selection.preview(selectionArea(shifted));
    },
    [selectionArea],
  );

  const previewPath = useMemo(() => {
    if (!screenPoints || screenPoints.length < 2) return null;
    const bounds = wrapperRef.current?.getBoundingClientRect();
    if (!bounds) return null;
    const path = screenPoints
      .map(
        (point, index) =>
          `${index === 0 ? 'M' : 'L'} ${point.x - bounds.left} ${point.y - bounds.top}`,
      )
      .join(' ');
    return `${path} Z`;
  }, [screenPoints, wrapperRef]);

  return {
    pointerHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
    },
    previewPath,
    isActive: screenPoints !== null,
    shiftScreenPoints,
    cancel,
  };
}
