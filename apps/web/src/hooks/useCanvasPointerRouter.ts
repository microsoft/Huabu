import { useEffect, useRef, type MutableRefObject } from 'react';

import { createViewportNavigationRecognizer } from '@/handler/canvasPointerRecognizers/viewportNavigation';
import { PointerRouterCore } from '@/handler/pointerRouter';

import type { CanvasPointerRouterContext } from '@/handler/canvasPointerRouterContext';
import type { PointerRecognizer } from '@/handler/pointerRouter';
import type {
  DeviceModePreference,
  EffectiveDeviceMode,
  EffectiveTouchInteractionMode,
} from '@/store/toolStore';
import type { ReactFlowInstance } from '@xyflow/react';

interface CanvasPointerRouterOptions {
  deviceMode: EffectiveDeviceMode;
  deviceModePreference: DeviceModePreference;
  touchInteractionMode: EffectiveTouchInteractionMode;
  explicitToolActive: boolean;
  onTouchTakeover: () => void;
  onEmptyCanvasTap: () => void;
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
    >[] = [createViewportNavigationRecognizer(), ...extraRecognizers];

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
        deviceMode: o.deviceMode,
        deviceModePreference: o.deviceModePreference,
        touchInteractionMode: o.touchInteractionMode,
        explicitToolActive: o.explicitToolActive,
        onTouchTakeover: o.onTouchTakeover,
        onEmptyCanvasTap: o.onEmptyCanvasTap,
      };
    });

    const onDown = (event: PointerEvent) => core.handleDown(event);
    const onMove = (event: PointerEvent) => core.handleMove(event);
    const onUp = (event: PointerEvent) => core.handleUp(event);
    const onCancel = (event: PointerEvent) => core.handleCancel(event);

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
