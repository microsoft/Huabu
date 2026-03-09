/**
 * Intent recognition store.
 *
 * Manages the loading / result / position state for the intent popover.
 */

import { createId } from '@sediment/shared';
import { create } from 'zustand';

import useCanvasStore from './canvasStore';
import { recognizeIntent, logIntentEpisode } from '../api/intent';
import { captureCanvasScreenshot } from '../utils/canvasScreenshot';
import { executeIntentActions } from '../utils/intentExecutor';

import type { IntentCandidate } from '@sediment/shared';

interface IntentState {
  isLoading: boolean;
  candidates: IntentCandidate[];
  position: { x: number; y: number } | null;
  isOpen: boolean;
  /** Serialized context summary for the current session (used for episode logging) */
  contextSummary: string;

  triggerIntent: (mouseX: number, mouseY: number) => Promise<void>;
  /** Execute a selected intent candidate and log the episode */
  executeIntent: (index: number) => void;
  /** Close the popover, log dismissal episode */
  dismiss: () => void;
}

export const useIntentStore = create<IntentState>()((set, get) => ({
  isLoading: false,
  candidates: [],
  position: null,
  isOpen: false,
  contextSummary: '',

  triggerIntent: async (mouseX, mouseY) => {
    set({
      isLoading: true,
      isOpen: true,
      position: { x: mouseX, y: mouseY },
      candidates: [],
      contextSummary: '',
    });

    document.body.style.cursor = 'progress';

    try {
      const canvasContext = useCanvasStore.getState().getAgentContext();

      const screenshot = await captureCanvasScreenshot({ stripPrefix: true });
      if (screenshot) {
        canvasContext.screenshot = screenshot;
      }

      // Build a short context summary for episode logging
      const summary = [
        `${canvasContext.nodes.length} nodes`,
        `${canvasContext.edges.length} edges`,
        `${canvasContext.selectedNodes.length} selected`,
        canvasContext.recentActions.length > 0
          ? `last action: ${canvasContext.recentActions[canvasContext.recentActions.length - 1].action}`
          : 'no recent actions',
      ].join(', ');

      const response = await recognizeIntent(canvasContext);

      set({
        candidates: response.intentCandidates,
        isLoading: false,
        contextSummary: summary,
      });
    } catch (err) {
      console.error('[Intent Recognition] Failed:', err);
      set({ candidates: [], isLoading: false, isOpen: false });
    } finally {
      document.body.style.cursor = '';
    }
  },

  executeIntent: (index: number) => {
    const { candidates, contextSummary } = get();
    const candidate = candidates[index];
    if (!candidate) return;

    console.log(
      `[Intent] Executing: "${candidate.label}" with ${candidate.actions.length} action(s)`,
      candidate.actions,
    );

    // Execute the action sequence
    if (candidate.actions.length > 0) {
      try {
        executeIntentActions(candidate.actions);
        console.log('[Intent] All actions executed successfully');
      } catch (err) {
        console.error('[Intent] Action execution failed:', err);
      }
    } else {
      console.warn('[Intent] No actions to execute for:', candidate.label);
    }

    // Log the episode
    void logIntentEpisode({
      id: createId('intent'),
      timestamp: Date.now(),
      contextSummary,
      candidates,
      outcome: {
        type: 'selected',
        chosenIndex: index,
        chosenLabel: candidate.label,
      },
    });

    set({ isOpen: false, candidates: [], position: null });
  },

  dismiss: () => {
    const { candidates, contextSummary } = get();

    // Log dismissal if there were candidates shown
    if (candidates.length > 0) {
      void logIntentEpisode({
        id: createId('intent'),
        timestamp: Date.now(),
        contextSummary,
        candidates,
        outcome: { type: 'dismissed' },
      });
    }

    set({ isOpen: false, candidates: [], position: null, isLoading: false });
    document.body.style.cursor = '';
  },
}));
