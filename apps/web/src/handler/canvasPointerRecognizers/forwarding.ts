import type { CanvasPointerRouterContext } from '@/handler/canvasPointerRouterContext';
import type { PointerRecognizer } from '@/handler/pointerRouter';

/**
 * Pointer handler quartet as exposed by the lasso / frame hooks. Typed on
 * the native `PointerEvent` the router dispatches; callers adapt their
 * React-synthetic handlers at the boundary.
 */
export interface ForwardedPointerHandlers {
  onPointerDown: (event: PointerEvent) => void;
  onPointerMove: (event: PointerEvent) => void;
  onPointerUp: (event: PointerEvent) => void;
  onPointerCancel: (event: PointerEvent) => void;
}

/**
 * Wrap an existing self-gating pointer handler set as a router recognizer.
 *
 * Registered through the global `observe` channel so the handlers see every
 * pointer event exactly as they did from the former bubble-phase fan-out —
 * they decide internally whether the current tool / target applies. Used to
 * fold `useCanvasLasso` and `useFrameDragToCreate` into the single pointer
 * router without rewriting their gesture logic.
 *
 * `getHandlers` is read per event so it can return the latest memoized
 * handlers via a ref, keeping the recognizer identity stable across renders.
 */
export function createForwardingRecognizer(
  id: string,
  getHandlers: () => ForwardedPointerHandlers,
): PointerRecognizer<PointerEvent, CanvasPointerRouterContext> {
  return {
    id,
    canClaim: () => false,
    onDown: () => 'pass',
    observe: {
      onDown: (event) => getHandlers().onPointerDown(event),
      onMove: (event) => getHandlers().onPointerMove(event),
      onUp: (event) => getHandlers().onPointerUp(event),
      onCancel: (event) => getHandlers().onPointerCancel(event),
    },
  };
}
