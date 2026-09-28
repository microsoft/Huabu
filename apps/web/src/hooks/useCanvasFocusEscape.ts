// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  useEffect,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';

import { useCanvasAttentionStore } from '@/store/canvasAttentionStore';
import useCanvasStore from '@/store/canvasStore';

/** Shield React Flow without swallowing document-level overlay dismissal. */
export function handleCanvasFocusEscape(event: ReactKeyboardEvent) {
  if (event.key !== 'Escape') return;
  // React Flow's node handler ignores defaultPrevented and runs before native
  // document/window listeners, even for React descendants portalled into body.
  // Stop only React's synthetic bubble: stopPropagation() would also stop the
  // native event and prevent useCloseOnEscape from dismissing an open menu.
  // The window policy below acts only if no child/overlay/gesture consumed it.
  event.isPropagationStopped = () => true;
}

/** Bubble-phase fallback: child editors, popovers and gesture cancellation win first. */
export function useCanvasFocusEscape(rootRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (
        !root ||
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        document.fullscreenElement ||
        !(event.target instanceof Element)
      )
        return;

      const target = event.target;
      const store = useCanvasStore.getState();
      // Pointer selection need not focus an element. In that case Escape is
      // dispatched on body, not on the programmatically focusable canvas root.
      const idleCanvasTarget =
        store.canvasWrapper === root &&
        useCanvasAttentionStore.getState().isCanvasEngaged &&
        !document.querySelector('[role="dialog"], [aria-modal="true"]') &&
        (target === document.body ||
          (root.contains(target) &&
            target.matches(
              '.react-flow, .react-flow__pane, .react-flow__renderer',
            )));
      if (target === root || idleCanvasTarget) {
        if (!store.nodes.some((node) => node.selected)) return;
        store.selectNodes([]);
        root.focus({ preventScroll: true });
      } else {
        const node = target.closest('.react-flow__node');
        const inSelectedNode =
          node &&
          root.contains(node) &&
          store.nodes.some(
            (entry) =>
              entry.id === node.getAttribute('data-id') && entry.selected,
          );
        const inToolbar =
          target.closest('.node-floating-toolbar') &&
          store.canvasWrapper === root;
        if (!inSelectedNode && !inToolbar) return;
        root.focus({ preventScroll: true });
      }
      event.preventDefault();
      event.stopPropagation();
    };
    // Window bubbling lets document-level overlay dismissal consume Escape first.
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [rootRef]);
}
