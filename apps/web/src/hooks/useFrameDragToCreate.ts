// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { isPanelTarget } from '../components/Panels/Canvas/canvasInputPolicy';

import type { ReactFlowInstance } from '@xyflow/react';

/**
 * Frame drag-to-create gesture.
 *
 * When the user picks the frame tool from the toolbar, dragging anywhere on
 * the canvas should sweep out a rectangle and create a frame around any nodes
 * inside it. We drive this off pointer events (not mouse events) so the same
 * code path works for mouse, pen, and touch — on touchscreens, mouse events
 * only fire on tap, never during a drag.
 */

interface Point {
  x: number;
  y: number;
}

interface FlowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DragRange {
  start: Point;
  end: Point;
}

/** Minimum frame size in flow-space pixels — guards against accidental taps. */
const MIN_FRAME_SIZE = 20;

interface UseFrameDragToCreateOptions {
  /** True when the user has picked the frame tool. */
  active: boolean;
  /** Canvas wrapper used to translate global coords to local for the preview. */
  wrapperRef: MutableRefObject<HTMLDivElement | null>;
  /** React Flow instance used for screen↔flow coordinate conversion. */
  rfInstanceRef: MutableRefObject<ReactFlowInstance | null>;
  /** Called with the final flow-space rectangle when the gesture commits. */
  onCreate: (rect: FlowRect) => void;
  /** Called whenever the gesture ends (commit, cancel, or escape). */
  onEnd: () => void;
}

interface UseFrameDragToCreateResult {
  /** Spread onto the canvas wrapper to wire up the gesture. */
  pointerHandlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => boolean;
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
  };
  /** Wrapper-relative preview rectangle to render while dragging, or null. */
  previewRect: {
    left: number;
    top: number;
    width: number;
    height: number;
  } | null;
}

export function useFrameDragToCreate({
  active,
  wrapperRef,
  rfInstanceRef,
  onCreate,
  onEnd,
}: UseFrameDragToCreateOptions): UseFrameDragToCreateResult {
  const [drag, setDrag] = useState<DragRange | null>(null);

  const cancel = useCallback(() => {
    setDrag(null);
    onEnd();
  }, [onEnd]);

  // Escape cancels a pending frame placement.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, cancel]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!active) return false;
      // Primary mouse button / primary touch / primary pen.
      if (e.button !== 0 || !e.isPrimary) return false;
      // Ignore presses that originate inside floating toolbars / panels.
      if (isPanelTarget(e.target as Element)) return false;

      e.preventDefault();
      e.stopPropagation();
      // Capture the pointer so move/up keep firing on the wrapper even if the
      // pointer drifts over child nodes. setPointerCapture cannot fail here:
      // pointerId comes from the active pointerdown.
      e.currentTarget.setPointerCapture(e.pointerId);

      const point = { x: e.clientX, y: e.clientY };
      setDrag({ start: point, end: point });
      return true;
    },
    [active],
  );

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    setDrag((prev) =>
      prev ? { start: prev.start, end: { x: e.clientX, y: e.clientY } } : prev,
    );
  }, []);

  const commitAndEnd = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // Pointer-up fires for every click on the wrapper, even when the user
      // wasn't drawing a frame (e.g. tapping the pane to place a Note). Bail
      // out early so we don't run `cancel()` and clobber `pendingNodeType`,
      // which would prevent click-to-place handlers from creating the node.
      if (!drag) return;
      e.currentTarget.releasePointerCapture(e.pointerId);

      const instance = rfInstanceRef.current;
      if (instance) {
        const startFlow = instance.screenToFlowPosition(drag.start);
        const endFlow = instance.screenToFlowPosition({
          x: e.clientX,
          y: e.clientY,
        });
        const x = Math.min(startFlow.x, endFlow.x);
        const y = Math.min(startFlow.y, endFlow.y);
        const width = Math.abs(endFlow.x - startFlow.x);
        const height = Math.abs(endFlow.y - startFlow.y);

        if (width >= MIN_FRAME_SIZE && height >= MIN_FRAME_SIZE) {
          onCreate({ x, y, width, height });
        }
      }
      cancel();
    },
    [drag, rfInstanceRef, onCreate, cancel],
  );

  const onPointerCancel = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!drag) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      cancel();
    },
    [drag, cancel],
  );

  // Translate the in-flight drag into a wrapper-relative rectangle for the
  // preview overlay. Returns null when there is no active drag.
  const previewRect = useMemo(() => {
    if (!drag) return null;
    const wrapperBounds = wrapperRef.current?.getBoundingClientRect();
    if (!wrapperBounds) return null;
    const x1 = drag.start.x - wrapperBounds.left;
    const y1 = drag.start.y - wrapperBounds.top;
    const x2 = drag.end.x - wrapperBounds.left;
    const y2 = drag.end.y - wrapperBounds.top;
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  }, [drag, wrapperRef]);

  return {
    pointerHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: commitAndEnd,
      onPointerCancel,
    },
    previewRect,
  };
}
