// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  canPlaceNodeWithPointer,
  isEmptyCanvasPlacementTarget,
  isNodePlacementTap,
} from '@/components/Panels/Canvas/canvasInputPolicy';
import { getDragActivationDistance } from '@/handler/canvasGestureSession';
import { useToolStore } from '@/store/toolStore';

import type { CanvasPointerRouterContext } from '@/handler/canvasPointerRouterContext';
import type { PointerRecognizer } from '@/handler/pointerRouter';

/**
 * Canvas-side callbacks the placement recognizer needs. Supplied as
 * stable functions (backed by refs) so the recognizer can be created
 * once and never lose its in-flight tap state to a re-render.
 */
export interface PlacementRecognizerDeps {
  /**
   * Create the pending node at the given screen point. Returns `true`
   * when a node was placed (so the next pane click can be suppressed).
   */
  placePendingNode: (clientX: number, clientY: number) => boolean;
  /** Suppress the pane click that React Flow fires right after placement. */
  suppressNextPaneClick: () => void;
}

/**
 * Click-to-place recognizer: an explicit primary tap on empty canvas
 * places the armed creation node. Ported from the former inline pointer
 * branch in `Canvas.tsx`. Mouse placement still flows through React
 * Flow's `onPaneClick`; this path owns the direct-manipulation pointer
 * tap (touch in Finger mode, pen in Pen mode) via `canPlaceNodeWithPointer`.
 */
export function createPlacementRecognizer(
  deps: PlacementRecognizerDeps,
): PointerRecognizer<PointerEvent, CanvasPointerRouterContext> {
  let pending: {
    pointerId: number;
    pointerType: string;
    startX: number;
    startY: number;
  } | null = null;

  return {
    id: 'click-to-place',
    canClaim: (event, ctx) => {
      const pendingNodeType = useToolStore.getState().pendingNodeType;
      return (
        pendingNodeType !== null &&
        pendingNodeType !== 'frame' &&
        pendingNodeType !== 'sketch' &&
        event.button === 0 &&
        event.isPrimary &&
        canPlaceNodeWithPointer(event.pointerType, ctx.inputMode) &&
        isEmptyCanvasPlacementTarget(event.target as Element)
      );
    },
    onDown: (event) => {
      pending = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        startX: event.clientX,
        startY: event.clientY,
      };
      event.preventDefault();
      event.stopPropagation();
      return 'claim';
    },
    onUp: (event) => {
      if (!pending || pending.pointerId !== event.pointerId) return;
      const start = pending;
      pending = null;
      if (
        isNodePlacementTap(
          start.startX,
          start.startY,
          event.clientX,
          event.clientY,
          getDragActivationDistance(start.pointerType),
        )
      ) {
        if (deps.placePendingNode(event.clientX, event.clientY)) {
          deps.suppressNextPaneClick();
        }
      }
      event.preventDefault();
      event.stopPropagation();
    },
    onCancel: (event) => {
      if (!pending || pending.pointerId !== event.pointerId) return;
      pending = null;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
