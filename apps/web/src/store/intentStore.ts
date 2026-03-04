/**
 * Intent recognition store.
 *
 * Manages the loading / result / position state for the intent popover.
 */

import { create } from 'zustand';

import useCanvasStore from './canvasStore';
import { recogniseIntent } from '../api/intent';
import { captureCanvasScreenshot } from '../utils/canvasScreenshot';

import type { IntentCandidate } from '@sediment/shared';

interface IntentState {
  /** Whether an intent recognition request is in flight */
  isLoading: boolean;
  /** The intent candidates returned by the backend */
  candidates: IntentCandidate[];
  /** Screen-space position where the popover should appear (near the mouse) */
  position: { x: number; y: number } | null;
  /** Whether the popover is visible */
  isOpen: boolean;

  /**
   * Trigger intent recognition.
   * Sets loading state, calls the API, stores results.
   *
   * @param mouseX - Screen X of the mouse when Ctrl+I was pressed
   * @param mouseY - Screen Y of the mouse when Ctrl+I was pressed
   */
  triggerIntent: (mouseX: number, mouseY: number) => Promise<void>;

  /** Close the popover and clear results */
  dismiss: () => void;
}

export const useIntentStore = create<IntentState>()((set) => ({
  isLoading: false,
  candidates: [],
  position: null,
  isOpen: false,

  triggerIntent: async (mouseX, mouseY) => {
    set({
      isLoading: true,
      isOpen: true,
      position: { x: mouseX, y: mouseY },
      candidates: [],
    });

    // Apply wait cursor on the whole page while loading
    document.body.style.cursor = 'progress';

    try {
      const canvasContext = useCanvasStore.getState().getAgentContext();

      // Capture a screenshot of the canvas viewport in parallel
      const screenshot = await captureCanvasScreenshot({ stripPrefix: true });
      if (screenshot) {
        canvasContext.screenshot = screenshot;
      }

      const response = await recogniseIntent(canvasContext);

      console.log('[Intent Recognition] Results:', response.intentCandidates);

      set({ candidates: response.intentCandidates, isLoading: false });
    } catch (err) {
      console.error('[Intent Recognition] Failed:', err);
      set({ candidates: [], isLoading: false, isOpen: false });
    } finally {
      document.body.style.cursor = '';
    }
  },

  dismiss: () => {
    set({ isOpen: false, candidates: [], position: null, isLoading: false });
    document.body.style.cursor = '';
  },
}));
