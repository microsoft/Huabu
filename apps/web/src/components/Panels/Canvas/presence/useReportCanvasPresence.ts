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
import { createEditingTracker } from '@/store/canvasPresence/editingTracker';
import {
  selectEditLockHolder,
  showEditLockedHint,
} from '@/store/canvasPresence/editLock';
import { createPresenceReporter } from '@/store/canvasPresence/presenceReporter';
import useCanvasStore, { flushNodeContent } from '@/store/canvasStore';
import { CANVAS_PAGE_ID } from '@/store/canvasStore/sync/pageId';

import type { Node } from '@xyflow/react';

const EDITABLE =
  'textarea, input, select, [contenteditable]:not([contenteditable="false"])';

/** What counts as the person still working in an editor. */
const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'input'] as const;

/**
 * The node whose text control has focus: a node edited in place on the
 * canvas, or the one open in the preview panel beside it. A read-only field
 * (a title that is shown in an input until it is edited) is not editing.
 */
export function editingNodeId(
  canvas: HTMLElement,
  active: Element | null,
): string | null {
  const control = active?.closest(EDITABLE);
  if (!active || !control) return null;
  if (
    (control instanceof HTMLInputElement ||
      control instanceof HTMLTextAreaElement) &&
    control.readOnly
  )
    return null;
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

    // The reported node is the other pages' edit lock on it.
    const presence = useCanvasPresenceStore.getState();
    const editing = createEditingTracker({
      focusedNodeId: () => editingNodeId(domNode, document.activeElement),
      pageActive: () =>
        document.hasFocus() && document.visibilityState !== 'hidden',
      report: (id) => reporter.setNodes({ editingNodeIds: id ? [id] : [] }),
      setLocal: (id) => presence.setLocalEditingNodeId(id),
      save: flushNodeContent,
      yieldIfHeldElsewhere: (id) => {
        const holder = selectEditLockHolder(
          {
            pages: useCanvasPresenceStore.getState().pages,
            localEditingNodeId: null,
          },
          id,
        );
        if (!holder) return false;
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
        showEditLockedHint(holder);
        return true;
      },
    });
    const syncEditing = (): void => editing.sync();
    const resumeEditing = (): void => editing.resume();
    const noteActivity = (): void => editing.activity();
    // On `focusout` the next element is not focused yet.
    const afterBlur = (): void => void setTimeout(syncEditing, 0);
    const windowBlur = (): void => {
      hidePointer();
      editing.sync();
    };

    const visibility = (): void => {
      if (document.visibilityState === 'hidden') {
        hidePointer();
        editing.sync();
      } else {
        reporter.announce();
        editing.resume();
      }
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
    window.addEventListener('blur', windowBlur);
    window.addEventListener('focus', resumeEditing);
    for (const type of ACTIVITY_EVENTS)
      document.addEventListener(type, noteActivity, {
        capture: true,
        passive: true,
      });
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pageHide);
    window.addEventListener('pageshow', pageShow);
    syncEditing();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      stopNodes();
      domNode.removeEventListener('pointermove', move, { capture: true });
      domNode.removeEventListener('pointerleave', hidePointer);
      document.removeEventListener('focusin', syncEditing);
      document.removeEventListener('focusout', afterBlur);
      editing.stop();
      window.removeEventListener('blur', windowBlur);
      window.removeEventListener('focus', resumeEditing);
      for (const type of ACTIVITY_EVENTS)
        document.removeEventListener(type, noteActivity, { capture: true });
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pageHide);
      window.removeEventListener('pageshow', pageShow);
      reporter.stop();
      useCanvasPresenceStore.getState().disconnect();
    };
  }, [canvasId, domNode]);
}
