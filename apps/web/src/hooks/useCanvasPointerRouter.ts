// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useRef, type MutableRefObject } from 'react';

import {
  canManipulateCanvasWithPointer,
  isPanelTarget,
} from '@/components/Panels/Canvas/canvasInputPolicy';
import { createInkSigilRecognizer } from '@/handler/canvasPointerRecognizers/inkSigil';
import { createNodeDragRecognizer } from '@/handler/canvasPointerRecognizers/nodeDrag';
import {
  canReadNoteWithPointer,
  createNoteContentRecognizer,
} from '@/handler/canvasPointerRecognizers/noteContent';
import { createViewportNavigationRecognizer } from '@/handler/canvasPointerRecognizers/viewportNavigation';
import { PointerRouterCore } from '@/handler/pointerRouter';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import { readEffectiveInputMode } from './useInputMode';

import type { CanvasPointerRouterContext } from '@/handler/canvasPointerRouterContext';
import type { PointerRecognizer } from '@/handler/pointerRouter';
import type { EffectiveInputMode } from '@/store/toolStore';
import type { ReactFlowInstance } from '@xyflow/react';

interface CanvasPointerRouterOptions {
  inputMode: EffectiveInputMode;
  explicitToolActive: boolean;
  inkToolActive?: boolean;
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
  const fingerReadingAllowed = canReadNoteWithPointer('touch', options);
  useEffect(() => {
    if (!fingerReadingAllowed) {
      useGesturePreviewStore.setState({ noteReadingNodeId: null });
    }
  }, [fingerReadingAllowed]);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const recognizers: PointerRecognizer<
      PointerEvent,
      CanvasPointerRouterContext
    >[] = [
      createInkSigilRecognizer(),
      createNoteContentRecognizer(),
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
        inputMode: readEffectiveInputMode(),
        explicitToolActive: o.explicitToolActive,
        inkToolActive: o.inkToolActive,
        onTouchTakeover: o.onTouchTakeover,
        onEmptyCanvasTap: o.onEmptyCanvasTap,
        onNodeTap: o.onNodeTap,
      };
    });

    const shouldBlock = (event: PointerEvent) =>
      !isPanelTarget(event.target as Element | null) &&
      !canManipulateCanvasWithPointer(
        event.pointerType,
        readEffectiveInputMode(),
      );
    const block = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    let suppressOwnedClick = false;
    let suppressOwnedTouch = false;
    let lastPointerType = '';
    const onDown = (event: PointerEvent) => {
      lastPointerType = event.pointerType;
      suppressOwnedClick = false;
      if (shouldBlock(event)) return block(event);
      core.handleDown(event);
      const owner = core.ownerOf(event.pointerId)?.id;
      suppressOwnedClick = owner === 'note-content' || owner === 'ink-sigil';
      if (
        (suppressOwnedClick || owner === 'node-drag') &&
        event.pointerType === 'touch'
      )
        suppressOwnedTouch = true;
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
    // Area selections also release capture on Escape/blur, before pointerup.
    const onLostCapture = (event: PointerEvent) => {
      const owner = core.ownerOf(event.pointerId)?.id;
      if (
        owner === 'mouse-marquee' ||
        owner === 'lasso' ||
        owner === 'note-content' ||
        owner === 'ink-sigil'
      ) {
        core.handleCancel(event);
      }
    };
    const onClick = (event: MouseEvent) => {
      const viewport =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-note-content-viewport]')
          : null;
      const touchNoteDoubleClick =
        event.type === 'dblclick' &&
        (lastPointerType === 'touch' || lastPointerType === 'pen') &&
        canReadNoteWithPointer(lastPointerType, {
          ...optionsRef.current,
          inputMode: readEffectiveInputMode(),
        }) &&
        viewport?.dataset.noteScrollEnabled === 'true' &&
        viewport.scrollHeight > viewport.clientHeight + 1;
      if ((!suppressOwnedClick && !touchNoteDoubleClick) || event.detail === 0)
        return;
      event.preventDefault();
      event.stopPropagation();
    };
    // React Flow's d3 drag also listens to legacy Touch Events. Pointer
    // ownership alone cannot stop that independent stream from moving a node.
    const onTouch = (event: TouchEvent) => {
      if (!suppressOwnedTouch) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.touches.length === 0) suppressOwnedTouch = false;
    };

    el.addEventListener('pointerdown', onDown, { capture: true });
    el.addEventListener('pointermove', onMove, { capture: true });
    el.addEventListener('pointerup', onUp, { capture: true });
    el.addEventListener('pointercancel', onCancel, { capture: true });
    el.addEventListener('lostpointercapture', onLostCapture, { capture: true });
    el.addEventListener('click', onClick, { capture: true });
    el.addEventListener('dblclick', onClick, { capture: true });
    el.addEventListener('touchstart', onTouch, {
      capture: true,
      passive: false,
    });
    el.addEventListener('touchmove', onTouch, {
      capture: true,
      passive: false,
    });
    el.addEventListener('touchend', onTouch, { capture: true, passive: false });
    el.addEventListener('touchcancel', onTouch, {
      capture: true,
      passive: false,
    });

    return () => {
      core.cancelAll();
      el.removeEventListener('pointerdown', onDown, { capture: true });
      el.removeEventListener('pointermove', onMove, { capture: true });
      el.removeEventListener('pointerup', onUp, { capture: true });
      el.removeEventListener('pointercancel', onCancel, { capture: true });
      el.removeEventListener('lostpointercapture', onLostCapture, {
        capture: true,
      });
      el.removeEventListener('click', onClick, { capture: true });
      el.removeEventListener('dblclick', onClick, { capture: true });
      el.removeEventListener('touchstart', onTouch, { capture: true });
      el.removeEventListener('touchmove', onTouch, { capture: true });
      el.removeEventListener('touchend', onTouch, { capture: true });
      el.removeEventListener('touchcancel', onTouch, { capture: true });
    };
  }, [wrapperRef, rfInstanceRef, extraRecognizers]);
}
