// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  canManipulateCanvasWithPointer,
  closestNodeElement,
  isNodeControlTarget,
  isPanelTarget,
} from '@/components/Panels/Canvas/canvasInputPolicy';
import {
  beginCanvasGesture,
  endCanvasGesture,
  updateCanvasGesture,
} from '@/handler/canvasGestureSession';
import { canTouchClaimViewport } from '@/handler/canvasInteractionOwner';
import { nodeIdAtScreenPoint } from '@/handler/canvasNodeAtPoint';
import useCanvasStore from '@/store/canvasStore';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';
import { useInkSigilStore } from '@/store/inkSigilStore';

import { createNodeDragRecognizer } from './nodeDrag';

import type { CanvasPointerRouterContext } from '@/handler/canvasPointerRouterContext';
import type { PointerRecognizer } from '@/handler/pointerRouter';

export function canReadNoteWithPointer(
  pointerType: string,
  ctx: Pick<
    CanvasPointerRouterContext,
    'inputMode' | 'explicitToolActive' | 'inkToolActive'
  >,
): boolean {
  return (
    (pointerType === 'touch' || pointerType === 'pen') &&
    canManipulateCanvasWithPointer(pointerType, ctx.inputMode) &&
    (!ctx.explicitToolActive ||
      (pointerType === 'touch' &&
        ctx.inputMode === 'pen' &&
        ctx.inkToolActive === true))
  );
}

function targetViewport(event: PointerEvent, ctx: CanvasPointerRouterContext) {
  if (
    !canReadNoteWithPointer(event.pointerType, ctx) ||
    !event.isPrimary ||
    event.button !== 0 ||
    isPanelTarget(event.target as Element | null) ||
    isNodeControlTarget(event.target as Element | null)
  )
    return null;
  const target = event.target instanceof Element ? event.target : null;
  let viewport = target?.closest<HTMLElement>('[data-note-content-viewport]');
  if (
    !viewport &&
    event.pointerType === 'touch' &&
    ctx.inputMode === 'pen' &&
    target?.closest('[data-sketch-overlay]')
  ) {
    const nodes = useCanvasStore.getState().nodes;
    const nodeId = nodeIdAtScreenPoint(event.clientX, event.clientY, {
      excludeNodeIds: new Set(
        nodes.filter((node) => node.type === 'sketch').map((node) => node.id),
      ),
    });
    if (nodeId) {
      viewport = ctx.wrapper.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${CSS.escape(nodeId)}"] [data-note-content-viewport]`,
      );
      const bounds = viewport?.getBoundingClientRect();
      if (
        !bounds ||
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        return null;
    }
  }
  const nodeId = closestNodeElement(viewport ?? null)?.dataset.id;
  if (
    !viewport ||
    !nodeId ||
    viewport.dataset.noteScrollEnabled !== 'true' ||
    viewport.scrollHeight <= viewport.clientHeight + 1
  )
    return null;
  const selected = useCanvasStore
    .getState()
    .nodes.filter((node) => node.selected);
  if (
    selected.length !== 1 ||
    selected[0].id !== nodeId ||
    selected[0].type !== 'note'
  )
    return null;
  return { viewport, nodeId };
}

/** Selected-body taps enter reading; reading drags scroll and taps deselect. */
export function createNoteContentRecognizer(): PointerRecognizer<
  PointerEvent,
  CanvasPointerRouterContext
> {
  let target: ReturnType<typeof targetViewport> = null;
  let pointerId: number | null = null;
  let captureTarget: HTMLDivElement | null = null;
  let reading = false;
  let startY = 0;
  let startTop = 0;
  let scale = 1;
  const drag = createNodeDragRecognizer({
    acceptsPointer: () => true,
    canDrag: (node) => node.data.locked !== true && node.draggable !== false,
    onTap: (nodeId) => {
      if (target?.nodeId === nodeId) {
        useGesturePreviewStore.setState({ noteReadingNodeId: nodeId });
      }
    },
  });
  const suppress = (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const reset = () => {
    const id = pointerId;
    const element = captureTarget;
    pointerId = null;
    captureTarget = null;
    target = null;
    if (id !== null) {
      endCanvasGesture(id);
      if (element?.hasPointerCapture(id)) element.releasePointerCapture(id);
    }
  };
  const isCurrent = (event: PointerEvent, ctx: CanvasPointerRouterContext) => {
    if (
      !target?.viewport.isConnected ||
      !canReadNoteWithPointer(event.pointerType, ctx)
    )
      return false;
    const selected = useCanvasStore
      .getState()
      .nodes.filter((node) => node.selected);
    return (
      canManipulateCanvasWithPointer(event.pointerType, ctx.inputMode) &&
      selected.length === 1 &&
      selected[0].id === target.nodeId &&
      target.viewport.dataset.noteScrollEnabled === 'true' &&
      (!reading ||
        useGesturePreviewStore.getState().noteReadingNodeId === target.nodeId)
    );
  };
  return {
    id: 'note-content',
    canClaim: (event, ctx) =>
      pointerId === null &&
      !useInkSigilStore.getState().pending &&
      canTouchClaimViewport() &&
      targetViewport(event, ctx) !== null,
    onDown: (event, ctx) => {
      target = targetViewport(event, ctx);
      if (!target) return 'pass';
      reading =
        useGesturePreviewStore.getState().noteReadingNodeId === target.nodeId;
      if (!reading) {
        if (!drag.canClaim(event, ctx) || drag.onDown(event, ctx) !== 'claim') {
          target = null;
          return 'pass';
        }
      } else {
        if (
          !beginCanvasGesture(
            'note-scroll',
            event.pointerId,
            event.pointerType === 'pen' ? 'pen' : 'touch',
            { x: event.clientX, y: event.clientY },
          )
        ) {
          target = null;
          return 'pass';
        }
        startY = event.clientY;
        startTop = target.viewport.scrollTop;
        scale =
          target.viewport.getBoundingClientRect().height /
            target.viewport.offsetHeight || 1;
        suppress(event);
      }
      pointerId = event.pointerId;
      captureTarget = ctx.wrapper;
      ctx.wrapper.setPointerCapture(event.pointerId);
      return 'claim';
    },
    onMove: (event, ctx) => {
      if (pointerId !== event.pointerId) return;
      suppress(event);
      if (!isCurrent(event, ctx)) {
        if (!reading) drag.onCancel?.(event, ctx);
        reset();
        return;
      }
      if (!reading) {
        drag.onMove?.(event, ctx);
      } else if (
        target &&
        updateCanvasGesture(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
        }) === 'locked'
      ) {
        target.viewport.scrollTop = startTop + (startY - event.clientY) / scale;
      }
    },
    onUp: (event, ctx) => {
      if (pointerId !== event.pointerId) return;
      suppress(event);
      if (!isCurrent(event, ctx)) {
        if (!reading) drag.onCancel?.(event, ctx);
      } else if (!reading) {
        drag.onUp?.(event, ctx);
      } else if (
        updateCanvasGesture(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
        }) === 'pending'
      ) {
        useGesturePreviewStore.setState({ noteReadingNodeId: null });
        useCanvasStore.getState().selectNodes([]);
      }
      reset();
    },
    onCancel: (event, ctx) => {
      if (pointerId !== event.pointerId) return;
      if (!reading) drag.onCancel?.(event, ctx);
      reset();
    },
  };
}
