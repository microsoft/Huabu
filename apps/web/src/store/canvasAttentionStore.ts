import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * Elements that count as "the canvas" when resolving attention.
 *
 * `[data-canvas-root]` is the React Flow wrapper in `Canvas`. Floating
 * chrome (node toolbar, multi-select toolbar, edge-style toolbar, the
 * connected-node picker) portals to `document.body`, so it is outside
 * that subtree and has to opt in explicitly via `[data-canvas-chrome]`
 * — without it, clicking a toolbar button would read as "the user left
 * the canvas" and the toolbar would vanish under its own pointer.
 */
const CANVAS_SURFACE_SELECTOR = '[data-canvas-root], [data-canvas-chrome]';

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
 * Tracks which surface the user is working in, so canvas floating chrome
 * can step aside while they are busy in the chat panel, an expanded node,
 * or the layer panel.
 *
 * Attention follows the last *deliberate* interaction — a pointer press or
 * a focus change — rather than the pointer position. Hover would be the
 * obvious signal and is the wrong one: merely sweeping the cursor across
 * the chat panel on the way somewhere else would blink the toolbar out and
 * back, and defending against that needs grace timers that then make the
 * toolbar feel laggy. A press/focus signal is discrete and sticky: chrome
 * disappears exactly once, when the user commits to another surface, and
 * comes back the moment they click into the canvas again.
 *
 * Listeners are capture-phase on `document` so a handler calling
 * `stopPropagation` (common inside popovers and editors) cannot blind us.
 * Call once from the canvas page; the state is process-wide.
 */
export function useTrackCanvasAttention(): void {
  useEffect(() => {
    const { setCanvasEngaged } = useCanvasAttentionStore.getState();
    const handleInteraction = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      setCanvasEngaged(target.closest(CANVAS_SURFACE_SELECTOR) !== null);
    };
    document.addEventListener('pointerdown', handleInteraction, true);
    document.addEventListener('focusin', handleInteraction, true);
    return () => {
      document.removeEventListener('pointerdown', handleInteraction, true);
      document.removeEventListener('focusin', handleInteraction, true);
      // Leaving the canvas page ends the arbitration; reset so the next
      // canvas mount doesn't inherit a stale "engaged elsewhere" verdict.
      setCanvasEngaged(true);
    };
  }, []);
}
