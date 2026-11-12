// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useReactFlow } from '@xyflow/react';
import { useEffect, useRef } from 'react';

import {
  leaveCanvasPresence,
  reportCanvasPresence,
} from '@/api/canvasPresence';
import { isElectron } from '@/hooks/useElectron';
import { useCanvasPresenceStore } from '@/store/canvasPresence/canvasPresenceStore';
import { presenceDeviceLabel } from '@/store/canvasPresence/deviceLabel';
import { createPresenceReporter } from '@/store/canvasPresence/presenceReporter';
import useCanvasStore from '@/store/canvasStore';
import { CANVAS_PAGE_ID } from '@/store/canvasStore/sync/pageId';

import type { Node } from '@xyflow/react';

const EDITABLE =
  'textarea, input, select, [contenteditable]:not([contenteditable="false"])';

/**
 * The node whose text control has focus: a node edited in place on the
 * canvas, or the one open in the preview panel beside it.
 */
export function editingNodeId(
  canvas: HTMLElement,
  active: Element | null,
): string | null {
  if (!active?.closest(EDITABLE)) return null;
  if (canvas.contains(active))
    return (
      active.closest<HTMLElement>('.react-flow__node[data-id]')?.dataset.id ??
      null
    );
  return (
    active.closest<HTMLElement>('[data-search-node-id]')?.dataset
      .searchNodeId ?? null
  );
}

/**
 * Tell the other pages what this page is doing in the Space: pointer position
 * over the canvas (flow coordinates), and the nodes it has selected, is
 * dragging or is editing. Only reads the canvas; nothing is written to
 * `canvasStore`, so reporting cannot mark the Space dirty or enter undo.
 */
export function useReportCanvasPresence(domNode: HTMLDivElement | null): void {
  const canvasId = useCanvasStore((state) => state.canvasId);
  const { screenToFlowPosition } = useReactFlow();
  const toFlow = useRef(screenToFlowPosition);
  toFlow.current = screenToFlowPosition;

  useEffect(() => {
    if (!canvasId || !domNode) return;
    const reporter = createPresenceReporter({
      pageId: CANVAS_PAGE_ID,
      label: presenceDeviceLabel(navigator.userAgent, isElectron()),
      send: (body) => reportCanvasPresence(canvasId, body),
      leave: () => leaveCanvasPresence(canvasId, { pageId: CANVAS_PAGE_ID }),
    });
    // Each (re)connect of the stream is when the server may have dropped us.
    useCanvasPresenceStore
      .getState()
      .connect(canvasId, () => reporter.announce());

    // Selection and drag state live on the nodes; read them when the array
    // changes instead of subscribing a component to it.
    let seen: readonly Node[] | null = null;
    const syncNodes = (state: { nodes: readonly Node[] }): void => {
      if (state.nodes === seen) return;
      seen = state.nodes;
      const selectedNodeIds: string[] = [];
      const draggingNodeIds: string[] = [];
      for (const node of state.nodes) {
        if (node.selected) selectedNodeIds.push(node.id);
        if (node.dragging) draggingNodeIds.push(node.id);
      }
      reporter.setNodes({ selectedNodeIds, draggingNodeIds });
    };
    syncNodes(useCanvasStore.getState());
    const stopNodes = useCanvasStore.subscribe(syncNodes);

    // Convert at most once per frame: the conversion reads layout.
    let frame = 0;
    let client: { x: number; y: number } | null = null;
    const convert = (): void => {
      frame = 0;
      if (!client) return;
      const flow = toFlow.current(client, { snapToGrid: false });
      reporter.setPointer({
        x: Math.round(flow.x * 10) / 10,
        y: Math.round(flow.y * 10) / 10,
      });
    };
    const move = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') return;
      client = { x: event.clientX, y: event.clientY };
      if (!frame) frame = requestAnimationFrame(convert);
    };
    const hidePointer = (): void => {
      client = null;
      reporter.setPointer(null);
    };

    const syncEditing = (): void => {
      const id = editingNodeId(domNode, document.activeElement);
      reporter.setNodes({ editingNodeIds: id ? [id] : [] });
    };
    // On `focusout` the next element is not focused yet.
    const afterBlur = (): void => void setTimeout(syncEditing, 0);

    const visibility = (): void => {
      if (document.visibilityState === 'hidden') hidePointer();
      else reporter.announce();
    };
    // The page may be restored from the back/forward cache, so withdraw
    // without stopping; `pageshow` announces it again.
    const pageHide = (): void =>
      leaveCanvasPresence(canvasId, { pageId: CANVAS_PAGE_ID });
    const pageShow = (): void => reporter.announce();

    domNode.addEventListener('pointermove', move, {
      capture: true,
      passive: true,
    });
    domNode.addEventListener('pointerleave', hidePointer);
    // Document-wide: a node is also edited in the preview panel.
    document.addEventListener('focusin', syncEditing);
    document.addEventListener('focusout', afterBlur);
    window.addEventListener('blur', hidePointer);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pageHide);
    window.addEventListener('pageshow', pageShow);
    syncEditing();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      stopNodes();
      domNode.removeEventListener('pointermove', move, { capture: true });
      domNode.removeEventListener('pointerleave', hidePointer);
      domNode.removeEventListener('focusin', syncEditing);
      domNode.removeEventListener('focusout', afterBlur);
      window.removeEventListener('blur', hidePointer);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pageHide);
      window.removeEventListener('pageshow', pageShow);
      reporter.stop();
      useCanvasPresenceStore.getState().disconnect();
    };
  }, [canvasId, domNode]);
}
