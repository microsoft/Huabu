// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect } from 'react';
import { create } from 'zustand';

import { useTrackAttention } from '@/hooks/useTrackAttention';

/**
 * The element that counts as "the canvas" when resolving attention.
 * `[data-canvas-root]` is the React Flow wrapper in `Canvas`.
 *
 * Canvas floating chrome (node toolbar, multi-select toolbar, edge-style
 * toolbar, the connected-node picker) portals to `document.body` and is
 * therefore outside that subtree — it is covered by the neutral
 * `FLOATING_CHROME_PROPS` marker instead, so pressing a toolbar button
 * never reads as "the user left the canvas".
 */
const CANVAS_SURFACE_SELECTOR = '[data-canvas-root]';

interface CanvasAttentionState {
  /**
   * Whether the canvas is the surface the user is currently working in.
   * Starts `true` so a freshly mounted canvas shows chrome before any
   * pointer or focus event has been observed.
   */
  isCanvasEngaged: boolean;
  setCanvasEngaged: (engaged: boolean) => void;
}

export const useCanvasAttentionStore = create<CanvasAttentionState>((set) => ({
  isCanvasEngaged: true,
  setCanvasEngaged: (engaged) =>
    set((s) =>
      s.isCanvasEngaged === engaged ? s : { isCanvasEngaged: engaged },
    ),
}));

/**
 * Publishes canvas attention into the store so canvas floating chrome
 * can step aside while the user works in the chat panel, an expanded
 * node, or the layer panel.
 *
 * A store rather than local state because the verdict is consumed by
 * components far from the canvas page; routing it through props would
 * re-render the whole page on every interaction.
 *
 * Call once from the canvas page; the state is process-wide.
 */
export function useTrackCanvasAttention(): void {
  useTrackAttention(
    (target) => target.closest(CANVAS_SURFACE_SELECTOR) !== null,
    useCanvasAttentionStore.getState().setCanvasEngaged,
  );

  useEffect(
    () => () => {
      // Leaving the canvas page ends the arbitration; reset so the next
      // canvas mount doesn't inherit a stale "engaged elsewhere" verdict.
      useCanvasAttentionStore.getState().setCanvasEngaged(true);
    },
    [],
  );
}
