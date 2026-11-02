// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  canDirectlyManipulateWithPointer,
  canStartRetainedSelectionMove,
} from '@/components/Panels/Canvas/canvasInputPolicy';
import { canTouchClaimViewport } from '@/handler/canvasInteractionOwner';
import { createNodeDragRecognizer } from '@/handler/canvasPointerRecognizers/nodeDrag';
import { getFrameDragRoots } from '@/handler/frameDragSelection';
import useCanvasStore from '@/store/canvasStore';

import { useAreaSelectionClickGuard } from './useAreaSelectionClickGuard';
import { useAutoPanDuringSelection } from './useAutoPanDuringSelection';

import type { CanvasPointerRouterContext } from '@/handler/canvasPointerRouterContext';
import type { PointerRecognizer } from '@/handler/pointerRouter';
import type { MutableRefObject } from 'react';

/** Claim inferred Frame moves before XYFlow captures child-local drag items. */
export function useFrameSelectionDrag({
  enabled,
  scopeKey,
  wrapperRef,
}: {
  enabled: boolean;
  scopeKey: string | null;
  wrapperRef: MutableRefObject<HTMLDivElement | null>;
}) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const sessionRef = useRef<{
    event: PointerEvent;
    ctx: CanvasPointerRouterContext;
    canvasId: string | null;
  } | null>(null);
  const [active, setActive] = useState(false);
  const suppressClick = useAreaSelectionClickGuard(wrapperRef, scopeKey);
  const driver = useMemo(
    () =>
      createNodeDragRecognizer({
        acceptsPointer: (event, ctx) => {
          if (
            !enabledRef.current ||
            ctx.explicitToolActive ||
            event.button !== 0 ||
            !canDirectlyManipulateWithPointer(
              event.pointerType,
              ctx.inputMode,
            ) ||
            !canTouchClaimViewport() ||
            !canStartRetainedSelectionMove(event.target as Element | null) ||
            (event.target instanceof Element &&
              event.target.closest('.nodrag, .nokey'))
          )
            return false;
          const nodes = useCanvasStore.getState().nodes;
          const selected = nodes.filter(
            (node) =>
              node.selected &&
              !node.data.locked &&
              node.draggable !== false &&
              (event.pointerType !== 'touch' || node.type !== 'sketch'),
          );
          return getFrameDragRoots(nodes, selected).some(
            (node) => !node.selected,
          );
        },
        onTap: (id, event) =>
          useCanvasStore
            .getState()
            .selectNodes([id], event.metaKey || event.ctrlKey),
        onActiveChange: setActive,
      }),
    [],
  );

  const finish = useCallback(
    (cancelled: boolean) => {
      const session = sessionRef.current;
      if (!session) return;
      sessionRef.current = null;
      const { event, ctx } = session;
      if (cancelled) driver.onCancel?.(event, ctx);
      else driver.onUp?.(event, ctx);
      if (session.canvasId === useCanvasStore.getState().canvasId)
        useCanvasStore.getState().setViewport(ctx.instance.getViewport());
      if (ctx.wrapper.hasPointerCapture(event.pointerId))
        ctx.wrapper.releasePointerCapture(event.pointerId);
    },
    [driver],
  );
  const cancel = useCallback(() => finish(true), [finish]);
  const recognizer = useMemo<
    PointerRecognizer<PointerEvent, CanvasPointerRouterContext>
  >(
    () => ({
      ...driver,
      id: 'frame-selection-drag',
      onDown: (event, ctx) => {
        const result = driver.onDown(event, ctx);
        if (result !== 'claim') return result;
        sessionRef.current = {
          event,
          ctx,
          canvasId: useCanvasStore.getState().canvasId,
        };
        suppressClick();
        ctx.wrapper.setPointerCapture(event.pointerId);
        ctx.wrapper.focus({ preventScroll: true });
        return 'claim';
      },
      onMove: (event, ctx) => {
        if (sessionRef.current?.event.pointerId !== event.pointerId) return;
        sessionRef.current = { ...sessionRef.current, event, ctx };
        if (!enabledRef.current || (event.buttons & 1) === 0) {
          cancel();
          return;
        }
        driver.onMove?.(event, ctx);
      },
      onUp: (event, ctx) => {
        if (sessionRef.current?.event.pointerId !== event.pointerId) return;
        sessionRef.current = { ...sessionRef.current, event, ctx };
        finish(!enabledRef.current);
      },
      onCancel: cancel,
    }),
    [driver, cancel, finish, suppressClick],
  );

  const pointer = useCallback(() => {
    const event = sessionRef.current?.event;
    return event ? { x: event.clientX, y: event.clientY } : null;
  }, []);
  useAutoPanDuringSelection({
    active,
    wrapperRef,
    updateNativeRectangle: false,
    getPointerPosition: pointer,
    onPan: () => {
      const session = sessionRef.current;
      if (session) {
        driver.onMove?.(session.event, session.ctx);
      }
    },
  });
  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled, cancel]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !sessionRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    const hidden = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', hidden);
      cancel();
    };
  }, [cancel, scopeKey]);
  return recognizer;
}
