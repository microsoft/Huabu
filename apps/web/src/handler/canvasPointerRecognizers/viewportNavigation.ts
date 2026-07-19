import { isPanelTarget } from '@/components/Panels/Canvas/canvasInputPolicy';
import {
  beginCanvasGesture,
  cancelPendingCanvasGesture,
  endCanvasGesture,
  updateCanvasGesture,
} from '@/handler/canvasGestureSession';
import {
  canTouchClaimViewport,
  canTouchTakeOverForPinch,
} from '@/handler/canvasInteractionOwner';
import {
  clampZoom,
  distance,
  midpoint,
  shouldOwnSingleTouchNavigation,
  shouldSuppressTouchEnd,
  zoomAroundPoint,
} from '@/hooks/useCanvasGestures';

import type { CanvasPointerRouterContext } from '@/handler/canvasPointerRouterContext';
import type {
  PointerRecognizer,
  PreemptContext,
} from '@/handler/pointerRouter';

interface Point {
  x: number;
  y: number;
}

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * Two-finger pinch + pan and single-finger empty-canvas pan on touch devices.
 *
 * Single-finger pan uses the router's exclusive owner lifecycle. The global
 * observer only tracks touch pointers so a second finger can cancel ordinary
 * owners (for example a pending lasso) and take over into a pinch. Pinch state
 * is captured when the second finger lands and held constant for the gesture
 * so the canvas pivots around a fixed point.
 */
export function createViewportNavigationRecognizer(): PointerRecognizer<
  PointerEvent,
  CanvasPointerRouterContext
> {
  let isPinching = false;
  let startDist = 0;
  let startMidpoint: Point = { x: 0, y: 0 };
  let startViewport: Viewport = { x: 0, y: 0, zoom: 1 };
  let panTouchId: number | null = null;
  let panStart: Point = { x: 0, y: 0 };
  let panStartViewport: Viewport = { x: 0, y: 0, zoom: 1 };
  const suppressedTouchIds = new Set<number>();
  const activeTouches = new Map<number, Point>();

  const observeDown = (
    event: PointerEvent,
    ctx: CanvasPointerRouterContext & PreemptContext,
  ): void => {
    if (event.pointerType !== 'touch') return;
    if (ctx.inputMode === 'mouse') return;
    if (isPanelTarget(event.target as Element | null)) return;
    const { instance } = ctx;
    const point = { x: event.clientX, y: event.clientY };
    activeTouches.set(event.pointerId, point);

    if (activeTouches.size === 2) {
      if (!canTouchTakeOverForPinch()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      ctx.onTouchTakeover();
      if (panTouchId === null) {
        cancelPendingCanvasGesture();
      }
      isPinching = true;
      const [first, second] = Array.from(activeTouches.entries());
      ctx.cancelPointer(first[0]);
      ctx.cancelPointer(second[0]);
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
      ctx.inputMode === 'pen' &&
      !isPanelTarget(event.target as Element | null)
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const observeMove = (
    event: PointerEvent,
    ctx: CanvasPointerRouterContext,
  ): void => {
    if (event.pointerType !== 'touch' || !activeTouches.has(event.pointerId)) {
      return;
    }
    const point = { x: event.clientX, y: event.clientY };
    activeTouches.set(event.pointerId, point);

    if (isPinching && activeTouches.size === 2) {
      const { instance } = ctx;
      event.preventDefault();
      event.stopPropagation();
      const [first, second] = Array.from(activeTouches.values());
      const newDist = distance(first, second);
      const newMidpoint = midpoint(first, second);
      const newZoom = clampZoom(
        startViewport.zoom * (newDist / Math.max(startDist, 1)),
      );
      const rect = ctx.wrapper.getBoundingClientRect();
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

    if (isPinching && suppressedTouchIds.has(event.pointerId)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const observeEnd = (event: PointerEvent): void => {
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
    if (isPinching && activeTouches.size === 0) {
      isPinching = false;
      suppressedTouchIds.clear();
    }
  };

  return {
    id: 'viewport-navigation',
    canClaim: (event, ctx) =>
      event.pointerType === 'touch' &&
      ctx.inputMode !== 'mouse' &&
      !isPanelTarget(event.target as Element | null) &&
      shouldOwnSingleTouchNavigation(event.target as Element | null, ctx) &&
      canTouchClaimViewport(),
    onDown: (event, ctx) => {
      const point = { x: event.clientX, y: event.clientY };
      ctx.onTouchTakeover();
      cancelPendingCanvasGesture();
      if (!beginCanvasGesture('touch-pan', event.pointerId, 'touch', point)) {
        return 'pass';
      }
      panTouchId = event.pointerId;
      panStart = point;
      panStartViewport = ctx.instance.getViewport();
      event.preventDefault();
      event.stopPropagation();
      return 'claim';
    },
    onMove: (event, ctx) => {
      if (panTouchId !== event.pointerId || activeTouches.size !== 1) return;
      const point = { x: event.clientX, y: event.clientY };
      event.preventDefault();
      event.stopPropagation();
      if (updateCanvasGesture(event.pointerId, point) !== 'locked') return;
      ctx.instance.setViewport(
        {
          x: panStartViewport.x + point.x - panStart.x,
          y: panStartViewport.y + point.y - panStart.y,
          zoom: panStartViewport.zoom,
        },
        { duration: 0 },
      );
    },
    onUp: (event, ctx) => {
      if (panTouchId !== event.pointerId) return;
      const phase = updateCanvasGesture(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
      endCanvasGesture(event.pointerId);
      panTouchId = null;
      if (phase === 'pending') ctx.onEmptyCanvasTap();
    },
    onCancel: (event) => {
      if (panTouchId !== event.pointerId) return;
      endCanvasGesture(event.pointerId);
      panTouchId = null;
    },
    observe: {
      onDown: observeDown,
      onMove: observeMove,
      onUp: observeEnd,
      onCancel: observeEnd,
    },
  };
}
