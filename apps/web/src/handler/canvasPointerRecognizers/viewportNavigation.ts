// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
import { nodeIdAtScreenPoint } from '@/handler/canvasNodeAtPoint';
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
  // The pointer-id pair currently driving the pinch. Whenever a finger is
  // added or lifted this pair changes; setting it to `null` forces the next
  // move to re-capture the baseline from the live finger positions and
  // viewport, which is what removes the freeze (3+ fingers) and the jump
  // (dropping back to a different two-finger pair).
  let pinchAnchorIds: [number, number] | null = null;

  const observeDown = (
    event: PointerEvent,
    ctx: CanvasPointerRouterContext & PreemptContext,
  ): void => {
    if (event.pointerType !== 'touch') return;
    if (ctx.inputMode === 'mouse') return;
    if (isPanelTarget(event.target as Element | null)) return;
    const point = { x: event.clientX, y: event.clientY };
    activeTouches.set(event.pointerId, point);

    if (activeTouches.size >= 2) {
      if (!canTouchTakeOverForPinch()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!isPinching) {
        // First transition into a pinch: take over any in-progress gesture
        // (pending Lasso / single-finger pan) so it can't fight the pinch.
        ctx.onTouchTakeover();
        if (panTouchId === null) {
          cancelPendingCanvasGesture();
        }
        isPinching = true;
        for (const id of activeTouches.keys()) ctx.cancelPointer(id);
      }
      // Every finger participating in the pinch has its `pointerup`
      // suppressed so React Flow never sees a stray tap when the gesture
      // ends. Invalidate the anchor so the next move re-captures a baseline
      // that matches the new finger set — no freeze, no jump.
      for (const id of activeTouches.keys()) suppressedTouchIds.add(id);
      pinchAnchorIds = null;
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

    if (isPinching && activeTouches.size >= 2) {
      const { instance } = ctx;
      event.preventDefault();
      event.stopPropagation();
      // Always drive the pinch from the first two active touches. When that
      // pair changes (a third finger lands, or one of the two lifts), capture
      // a fresh baseline from the current positions and viewport, then wait
      // for the next move so the zoom continues smoothly from where it was.
      const [first, second] = Array.from(activeTouches.entries());
      if (
        pinchAnchorIds === null ||
        pinchAnchorIds[0] !== first[0] ||
        pinchAnchorIds[1] !== second[0]
      ) {
        startDist = distance(first[1], second[1]);
        startMidpoint = midpoint(first[1], second[1]);
        startViewport = instance.getViewport();
        pinchAnchorIds = [first[0], second[0]];
        return;
      }
      const newDist = distance(first[1], second[1]);
      const newMidpoint = midpoint(first[1], second[1]);
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
    if (isPinching) {
      if (activeTouches.size === 0) {
        isPinching = false;
        suppressedTouchIds.clear();
      }
      // A finger lifted mid-pinch: invalidate the anchor so the surviving
      // pair re-captures its baseline on the next move instead of jumping.
      pinchAnchorIds = null;
    }
  };

  return {
    id: 'viewport-navigation',
    canClaim: (event, ctx) =>
      event.pointerType === 'touch' &&
      ctx.inputMode !== 'mouse' &&
      // While a pinch is live, extra fingers must not spin up a competing
      // single-finger pan owner; they only extend the pinch touch set.
      !isPinching &&
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
      // A tap (never locked into a pan) selects the node it landed on, or
      // clears the selection on empty canvas. The node is resolved from the
      // shared screen-point hit-test rather than the event target so it
      // works even when a full-screen tool overlay (Sketch) covers the
      // node and steals the DOM target — the pen keeps drawing while the
      // finger picks nodes.
      if (phase === 'pending' && !ctx.interactivityLocked) {
        const nodeId = nodeIdAtScreenPoint(panStart.x, panStart.y);
        if (nodeId) ctx.onNodeTap(nodeId);
        else ctx.onEmptyCanvasTap();
      }
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
