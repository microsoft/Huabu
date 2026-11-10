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

const MIN_LASSO_POINTS = 3;
const MIN_LASSO_SPAN = 10;

type LassoPointerEvent = PointerEvent | ReactPointerEvent<HTMLDivElement>;

interface UseCanvasLassoOptions {
  active: boolean;
  scopeKey: string | null;
  wrapperRef: MutableRefObject<HTMLDivElement | null>;
  rfInstanceRef: MutableRefObject<ReactFlowInstance | null>;
  inputMode: EffectiveInputMode;
  readInputPolicy?: () => { active: boolean; inputMode: EffectiveInputMode };
}

function appendPoint(points: XYPosition[], next: XYPosition) {
  const last = points.at(-1);
  if (!last || last.x !== next.x || last.y !== next.y) {
    points.push(next);
  }
}

function hasEnoughArea(points: XYPosition[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return maxX - minX >= MIN_LASSO_SPAN && maxY - minY >= MIN_LASSO_SPAN;
}

export function useCanvasLasso({
  active,
  scopeKey,
  wrapperRef,
  rfInstanceRef,
  inputMode,
  readInputPolicy,
}: UseCanvasLassoOptions) {
  const flowStore = useStoreApi();
  const suppressClick = useAreaSelectionClickGuard(wrapperRef, scopeKey);
  const [screenPoints, setScreenPoints] = useState<XYPosition[] | null>(null);
  // Pointerup and auto-pan must see the last event even before React renders.
  const pointsRef = useRef<XYPosition[] | null>(null);
  const optionsRef = useRef({ active, scopeKey, readInputPolicy });
  optionsRef.current = { active, scopeKey, readInputPolicy };
  const pendingRef = useRef<{
    pointerId: number;
    points: XYPosition[];
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
    (event: LassoPointerEvent) => {
      const policy = readInputPolicy?.() ?? { active, inputMode };
      if (
        !policy.active ||
        useGesturePreviewStore.getState().inkSubmissionPreparing
      )
        return false;
      if (event.button !== 0 || !event.isPrimary) return false;
      if (
        event.pointerType !== 'mouse' &&
        (policy.inputMode === 'mouse' ||
          (policy.inputMode === 'pen' && event.pointerType !== 'pen') ||
          (policy.inputMode === 'finger' && event.pointerType !== 'touch'))
      )
        return false;
      if (!isLassoStartTarget(event.target as HTMLElement)) return false;
      const wrapper = wrapperRef.current;
      if (!wrapper) return false;
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
      wrapper.setPointerCapture(event.pointerId);
      wrapper.focus({ preventScroll: true });
      suppressClick();
      pendingRef.current = {
        pointerId: event.pointerId,
        points: [start],
        captureTarget: wrapper,
        scopeKey,
        selection: createAreaSelectionSession(true),
        nodesSelectionActive: flowStore.getState().nodesSelectionActive,
      };
      return true;
    },
    [
      active,
      flowStore,
      inputMode,
      scopeKey,
      suppressClick,
      wrapperRef,
      readInputPolicy,
    ],
  );

  const onPointerMove = useCallback(
    (event: LassoPointerEvent) => {
      const pending = pendingRef.current;
      if (!pending || pending.pointerId !== event.pointerId) return;
      if (
        !(
          optionsRef.current.readInputPolicy?.().active ??
          optionsRef.current.active
        ) ||
        !(event.buttons & 1)
      ) {
        cancel();
        return;
      }
      const nativeEvent = 'nativeEvent' in event ? event.nativeEvent : event;
      const samples = nativeEvent.getCoalescedEvents?.() ?? [];
      const points = [...(pointsRef.current ?? pending.points)];
      let locked = false;
      // The endpoint may duplicate the final coalesced sample; appendPoint deduplicates it.
      for (const sample of [...samples, nativeEvent]) {
        const next = { x: sample.clientX, y: sample.clientY };
        appendPoint(points, next);
        if (updateCanvasGesture(event.pointerId, next) === 'locked') {
          locked = true;
        }
      }
      pending.points = points;
      if (!locked) return;
      if (!pointsRef.current) {
        flowStore.setState({
          userSelectionActive: true,
          nodesSelectionActive: false,
        });
      }
      pointsRef.current = points;
      setScreenPoints(points);
      pending.selection.preview(selectionArea(points));
    },
    [cancel, flowStore, selectionArea],
  );

  const onPointerUp = useCallback(
    (event: LassoPointerEvent) => {
      const pending = pendingRef.current;
      if (
        !pending ||
        pending.pointerId !== event.pointerId ||
        event.button !== 0
      )
        return;
      if (
        !(
          optionsRef.current.readInputPolicy?.().active ??
          optionsRef.current.active
        ) ||
        pending.scopeKey !== optionsRef.current.scopeKey
      ) {
        cancel();
        return;
      }
      const points = pointsRef.current;
      const finalPoints = points ? [...points] : [];
      if (points) {
        appendPoint(finalPoints, { x: event.clientX, y: event.clientY });
      }
      pending.selection.commit(selectionArea(finalPoints));
      finish(false);
    },
    [cancel, finish, selectionArea],
  );
  const onPointerCancel = useCallback(
    (event: LassoPointerEvent) => {
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
