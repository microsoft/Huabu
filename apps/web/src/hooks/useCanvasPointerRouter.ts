// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useRef, type MutableRefObject } from 'react';

import {
  canManipulateCanvasWithPointer,
  isPanelTarget,
} from '@/components/Panels/Canvas/canvasInputPolicy';
import { createNodeDragRecognizer } from '@/handler/canvasPointerRecognizers/nodeDrag';
import { createViewportNavigationRecognizer } from '@/handler/canvasPointerRecognizers/viewportNavigation';
import { PointerRouterCore } from '@/handler/pointerRouter';

import type { CanvasPointerRouterContext } from '@/handler/canvasPointerRouterContext';
import type { PointerRecognizer } from '@/handler/pointerRouter';
import type { EffectiveInputMode } from '@/store/toolStore';
import type { ReactFlowInstance } from '@xyflow/react';

interface CanvasPointerRouterOptions {
  inputMode: EffectiveInputMode;
  interactivityLocked: boolean;
  explicitToolActive: boolean;
  onTouchTakeover: () => void;
  onEmptyCanvasTap: () => void;
  onNodeTap: (nodeId: string) => void;
}

/**
 * Installs the single capture-phase pointer stream for the canvas and
 * drives a {@link PointerRouterCore}. Recognizers registered here own,
 * observe, and preempt canvas gestures through one arbitration protocol.
 *
 * The built-in `viewport-navigation` recognizer runs first (as a global
 * observer); `extraRecognizers` are offered the claim after it, in order.
 * `extraRecognizers` must be a stable array — a changing identity would
 * re-install the listeners and drop any in-flight gesture.
 *
 * Must be called from inside `<ReactFlow>` so the recognizers can reach
 * the viewport through the shared React Flow instance ref.
 */
export function useCanvasPointerRouter(
  wrapperRef: MutableRefObject<HTMLDivElement | null>,
  rfInstanceRef: MutableRefObject<ReactFlowInstance | null>,
  options: CanvasPointerRouterOptions,
  extraRecognizers: PointerRecognizer<
    PointerEvent,
    CanvasPointerRouterContext
  >[] = [],
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const recognizers: PointerRecognizer<
      PointerEvent,
      CanvasPointerRouterContext
    >[] = [
      // Offered before viewport-navigation so a Pen-mode finger pressing
      // an already-selected node drags it instead of panning; everything
      // else falls through to viewport navigation / tap-select.
      createNodeDragRecognizer(),
      createViewportNavigationRecognizer(),
      ...extraRecognizers,
    ];

    const core = new PointerRouterCore<
      PointerEvent,
      CanvasPointerRouterContext
    >(recognizers, () => {
      const wrapper = wrapperRef.current;
      const instance = rfInstanceRef.current;
      if (!wrapper || !instance) return null;
      const o = optionsRef.current;
      return {
        wrapper,
        instance,
        inputMode: o.inputMode,
        interactivityLocked: o.interactivityLocked,
        explicitToolActive: o.explicitToolActive,
        onTouchTakeover: o.onTouchTakeover,
        onEmptyCanvasTap: o.onEmptyCanvasTap,
        onNodeTap: o.onNodeTap,
      };
    });

    const shouldBlock = (event: PointerEvent) =>
      !isPanelTarget(event.target as Element | null) &&
      !canManipulateCanvasWithPointer(
        event.pointerType,
        optionsRef.current.inputMode,
      );
    const block = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    const onDown = (event: PointerEvent) => {
      if (shouldBlock(event)) return block(event);
      core.handleDown(event);
    };
    const onMove = (event: PointerEvent) => {
      if (shouldBlock(event)) return block(event);
      core.handleMove(event);
    };
    const onUp = (event: PointerEvent) => {
      if (shouldBlock(event)) return block(event);
      core.handleUp(event);
    };
    const onCancel = (event: PointerEvent) => {
      if (shouldBlock(event)) return block(event);
      core.handleCancel(event);
    };

    el.addEventListener('pointerdown', onDown, { capture: true });
    el.addEventListener('pointermove', onMove, { capture: true });
    el.addEventListener('pointerup', onUp, { capture: true });
    el.addEventListener('pointercancel', onCancel, { capture: true });

    return () => {
      el.removeEventListener('pointerdown', onDown, { capture: true });
      el.removeEventListener('pointermove', onMove, { capture: true });
      el.removeEventListener('pointerup', onUp, { capture: true });
      el.removeEventListener('pointercancel', onCancel, { capture: true });
    };
  }, [wrapperRef, rfInstanceRef, extraRecognizers]);
}
