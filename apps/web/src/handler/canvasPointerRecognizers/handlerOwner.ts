// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { CanvasPointerRouterContext } from '@/handler/canvasPointerRouterContext';
import type { PointerRecognizer } from '@/handler/pointerRouter';

export interface OwnedPointerHandlers {
  onPointerDown: (event: PointerEvent) => boolean;
  onPointerMove: (event: PointerEvent) => void;
  onPointerUp: (event: PointerEvent) => void;
  onPointerCancel: (event: PointerEvent) => void;
}

/** Adapt a stateful gesture hook to the router's exclusive owner lifecycle. */
export function createHandlerOwnerRecognizer(
  id: string,
  getHandlers: () => OwnedPointerHandlers,
  canClaim: (event: PointerEvent, ctx: CanvasPointerRouterContext) => boolean,
): PointerRecognizer<PointerEvent, CanvasPointerRouterContext> {
  return {
    id,
    canClaim,
    onDown: (event) => (getHandlers().onPointerDown(event) ? 'claim' : 'pass'),
    onMove: (event) => getHandlers().onPointerMove(event),
    onUp: (event) => getHandlers().onPointerUp(event),
    onCancel: (event) => getHandlers().onPointerCancel(event),
  };
}
