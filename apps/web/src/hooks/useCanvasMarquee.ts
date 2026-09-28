// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useStoreApi } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  marqueeStartTarget,
  rectangleBetween,
} from '@/components/Panels/Canvas/marqueeSelection';
import {
  beginCanvasGesture,
  endCanvasGesture,
  updateCanvasGesture,
} from '@/handler/canvasGestureSession';
import { canTouchClaimViewport } from '@/handler/canvasInteractionOwner';
import useCanvasStore from '@/store/canvasStore';

import { createAreaSelectionSession } from './areaSelectionSession';
import { useAreaSelectionClickGuard } from './useAreaSelectionClickGuard';
import { useAutoPanDuringSelection } from './useAutoPanDuringSelection';

import type { CanvasPointerRouterContext } from '@/handler/canvasPointerRouterContext';
import type { PointerRecognizer } from '@/handler/pointerRouter';
import type { ReactFlowInstance, XYPosition } from '@xyflow/react';
import type { MutableRefObject } from 'react';

interface Options {
  enabled: boolean;
  scopeKey: string | null;
  wrapperRef: MutableRefObject<HTMLDivElement | null>;
  rfInstanceRef: MutableRefObject<ReactFlowInstance | null>;
  onActiveChange: (active: boolean) => void;
}

interface Session {
  scopeKey: string | null;
  pointerId: number;
  frameId: string | null;
  start: XYPosition;
  cursor: XYPosition;
  selection: ReturnType<typeof createAreaSelectionSession>;
  nodesSelectionActive: boolean;
  toggle: boolean;
  locked: boolean;
}

/** One mouse rectangle owner for pane and unselected Frame bodies. No native event replay. */
export function useCanvasMarquee(options: Options) {
  const flowStore = useStoreApi();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const sessionRef = useRef<Session | null>(null);
  const suppressClick = useAreaSelectionClickGuard(
    options.wrapperRef,
    options.scopeKey,
  );
  const [active, setActive] = useState(false);

  const refresh = useCallback(() => {
    const session = sessionRef.current;
    const instance = optionsRef.current.rfInstanceRef.current;
    const wrapper = optionsRef.current.wrapperRef.current;
    if (!session?.locked || !instance || !wrapper) return;
    const end = instance.screenToFlowPosition(session.cursor, {
      snapToGrid: false,
    });
    session.selection.preview({
      kind: 'rectangle',
      rect: rectangleBetween(session.start, end),
    });
    const bounds = wrapper.getBoundingClientRect();
    const start = instance.flowToScreenPosition(session.start);
    const rect = rectangleBetween(start, session.cursor);
    flowStore.setState({
      userSelectionActive: true,
      nodesSelectionActive: false,
      userSelectionRect: {
        ...rect,
        x: rect.x - bounds.left,
        y: rect.y - bounds.top,
        startX: session.start.x,
        startY: session.start.y,
      },
    });
  }, [flowStore]);

  const finish = useCallback(
    (cancelled: boolean) => {
      const session = sessionRef.current;
      if (!session) return;
      sessionRef.current = null;
      const { wrapperRef, rfInstanceRef, onActiveChange } = optionsRef.current;
      // Navigation must not restore IDs from the previous canvas into the new one.
      const sameCanvas = session.scopeKey === optionsRef.current.scopeKey;
      if (sameCanvas && cancelled) {
        session.selection.cancel();
      } else if (sameCanvas) {
        const state = useCanvasStore.getState();
        if (session.locked) {
          const instance = rfInstanceRef.current;
          if (instance)
            session.selection.commit({
              kind: 'rectangle',
              rect: rectangleBetween(
                session.start,
                instance.screenToFlowPosition(session.cursor, {
                  snapToGrid: false,
                }),
              ),
            });
        } else {
          state.selectNodes(
            session.frameId ? [session.frameId] : [],
            session.frameId !== null && session.toggle,
          );
          state.onEdgesChange(
            state.edges
              .filter((edge) => edge.selected)
              .map((edge) => ({
                type: 'select',
                id: edge.id,
                selected: false,
              })),
          );
        }
      }
      endCanvasGesture(session.pointerId);
      flowStore.setState({
        userSelectionActive: false,
        userSelectionRect: null,
        // Only completed rectangles create native group-drag chrome. A Frame
        // click uses ordinary node chrome so its title and handles stay exposed.
        nodesSelectionActive:
          sameCanvas && cancelled
            ? session.nodesSelectionActive
            : sameCanvas &&
              session.locked &&
              useCanvasStore.getState().nodes.some((node) => node.selected),
      });
      const wrapper = wrapperRef.current;
      if (wrapper?.hasPointerCapture(session.pointerId))
        wrapper.releasePointerCapture(session.pointerId);
      if (session.locked) {
        setActive(false);
        onActiveChange(false);
        const viewport = rfInstanceRef.current?.getViewport();
        if (viewport && sameCanvas)
          useCanvasStore.getState().setViewport(viewport);
      }
    },
    [flowStore],
  );
  const cancel = useCallback(() => finish(true), [finish]);

  const recognizer = useMemo<
    PointerRecognizer<PointerEvent, CanvasPointerRouterContext>
  >(
    () => ({
      id: 'mouse-marquee',
      canClaim: (event, ctx) =>
        optionsRef.current.enabled &&
        !ctx.explicitToolActive &&
        event.pointerType === 'mouse' &&
        event.isPrimary &&
        event.button === 0 &&
        !event.defaultPrevented &&
        !sessionRef.current &&
        canTouchClaimViewport() &&
        marqueeStartTarget(event.target, useCanvasStore.getState().nodes) !==
          null,
      onDown: (event, ctx) => {
        const target = marqueeStartTarget(
          event.target,
          useCanvasStore.getState().nodes,
        );
        if (!target) return 'pass';
        const cursor = { x: event.clientX, y: event.clientY };
        if (!beginCanvasGesture('marquee', event.pointerId, 'mouse', cursor))
          return 'pass';
        sessionRef.current = {
          scopeKey: optionsRef.current.scopeKey,
          pointerId: event.pointerId,
          frameId: target.frameId,
          start: ctx.instance.screenToFlowPosition(cursor, {
            snapToGrid: false,
          }),
          cursor,
          selection: createAreaSelectionSession(),
          nodesSelectionActive: flowStore.getState().nodesSelectionActive,
          toggle: event.metaKey || event.ctrlKey,
          locked: false,
        };
        suppressClick();
        ctx.wrapper.setPointerCapture(event.pointerId);
        ctx.wrapper.focus({ preventScroll: true });
        // Cancel compatibility mousedown before XYFlow can select/drag the Frame.
        event.preventDefault();
        event.stopPropagation();
        return 'claim';
      },
      onMove: (event) => {
        const session = sessionRef.current;
        if (!session || session.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        if (!optionsRef.current.enabled || !(event.buttons & 1)) {
          cancel();
          return;
        }
        session.cursor = { x: event.clientX, y: event.clientY };
        if (updateCanvasGesture(event.pointerId, session.cursor) !== 'locked')
          return;
        if (!session.locked) {
          session.locked = true;
          setActive(true);
          optionsRef.current.onActiveChange(true);
        }
        refresh();
      },
      onUp: (event) => {
        const session = sessionRef.current;
        if (
          !session ||
          session.pointerId !== event.pointerId ||
          event.button !== 0
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        session.cursor = { x: event.clientX, y: event.clientY };
        refresh();
        finish(!optionsRef.current.enabled);
      },
      onCancel: cancel,
    }),
    [cancel, finish, refresh, flowStore, suppressClick],
  );

  const getPointerPosition = useCallback(
    () => sessionRef.current?.cursor ?? null,
    [],
  );
  useAutoPanDuringSelection({
    active,
    wrapperRef: options.wrapperRef,
    updateNativeRectangle: false,
    getPointerPosition,
  });

  useEffect(() => {
    if (!options.enabled) cancel();
  }, [options.enabled, cancel]);
  useEffect(() => {
    const wrapper = options.wrapperRef.current;
    if (!wrapper) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !sessionRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    const hidden = () => {
      if (document.hidden) cancel();
    };
    const lostCapture = (event: PointerEvent) => {
      if (event.pointerId === sessionRef.current?.pointerId) cancel();
    };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', hidden);
    wrapper.addEventListener('lostpointercapture', lostCapture);
    const unsubscribe = flowStore.subscribe((state, previous) => {
      if (state.transform !== previous.transform) refresh();
    });
    return () => {
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', hidden);
      wrapper.removeEventListener('lostpointercapture', lostCapture);
      unsubscribe();
      cancel();
    };
  }, [cancel, refresh, flowStore, options.wrapperRef, options.scopeKey]);

  return { recognizer, cancel };
}
