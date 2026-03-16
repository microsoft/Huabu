/**
 * Intent recognition store.
 *
 * Manages a two-step intent flow:
 *   Step 1 (intent-select): show intent candidates + custom input, let user pick one
 *   Step 2 (action-review): resolve chosen intent into actions, show editable action list
 */

import { createId } from '@sediment/shared';
import { create } from 'zustand';

import useCanvasStore from './canvasStore';
import {
  recognizeIntentStream,
  resolveActions,
  logIntentEpisode,
} from '../api/intent';
import { captureCanvasScreenshot } from '../utils/canvas/screenshot';
import { executeIntentActions } from '../utils/intent/executor';

import type {
  AgentBaseContext,
  IntentAction,
  IntentCandidate,
} from '@sediment/shared';

export type IntentStep = 'intent-select' | 'action-review';

interface IntentState {
  isOpen: boolean;
  isLoading: boolean;
  /** True while the LLM is still streaming candidates (candidates may already be partially available) */
  isStreaming: boolean;
  step: IntentStep;
  /** Intent candidates from step 1 */
  candidates: IntentCandidate[];
  /** Index of the selected candidate (or -1 for custom) */
  selectedIndex: number;
  /** Custom intent typed by user */
  customIntent: string;
  /** Resolved actions for step 2 */
  actions: IntentAction[];
  position: { x: number; y: number } | null;
  /** Stored canvas context so step 2 can reuse it */
  canvasContext: AgentBaseContext | null;
  contextSummary: string;

  triggerIntent: (mouseX: number, mouseY: number) => Promise<void>;
  /** Select an intent candidate (step 1 → loading → step 2) */
  selectCandidate: (index: number) => Promise<void>;
  /** Submit custom intent text (step 1 → loading → step 2) */
  submitCustomIntent: (text: string) => Promise<void>;
  setCustomIntent: (text: string) => void;
  /** Update a single action in the actions list */
  updateAction: (actionIndex: number, updated: IntentAction) => void;
  /** Reset actions back to the original resolved list */
  resetActions: () => void;
  /** Go back from step 2 to step 1 */
  goBack: () => void;
  /** Execute the current action list */
  execute: () => void;
  dismiss: () => void;
}

// Keep a copy of the originally resolved actions so "reset" can restore them.
let originalActions: IntentAction[] = [];

/**
 * Cache of resolved actions keyed by intent label / custom text.
 * Allows instant switching back to a previously resolved intent.
 */
const actionCache = new Map<
  string,
  { actions: IntentAction[]; original: IntentAction[] }
>();

/** Build a cache key from the current selection */
function cacheKey(
  index: number,
  candidates: IntentCandidate[],
  custom: string,
): string {
  return index >= 0
    ? `candidate:${candidates[index]?.label ?? index}`
    : `custom:${custom}`;
}

export const useIntentStore = create<IntentState>()((set, get) => ({
  isOpen: false,
  isLoading: false,
  isStreaming: false,
  step: 'intent-select' as IntentStep,
  candidates: [],
  selectedIndex: -1,
  customIntent: '',
  actions: [],
  position: null,
  canvasContext: null,
  contextSummary: '',

  triggerIntent: async (mouseX, mouseY) => {
    // Clear the action cache on each new trigger
    actionCache.clear();

    set({
      isLoading: true,
      isStreaming: true,
      isOpen: true,
      step: 'intent-select',
      position: { x: mouseX, y: mouseY },
      candidates: [],
      actions: [],
      selectedIndex: -1,
      customIntent: '',
      contextSummary: '',
      canvasContext: null,
    });

    try {
      const canvasContext = useCanvasStore.getState().getAgentContext();

      const lastAction =
        canvasContext.recentActions.length > 0
          ? canvasContext.recentActions[canvasContext.recentActions.length - 1]
          : undefined;

      const screenshot = await captureCanvasScreenshot({
        stripPrefix: true,
        lastAction,
      });
      if (screenshot) {
        canvasContext.screenshot = screenshot;
      }

      const summary = [
        `${canvasContext.nodes.length} nodes`,
        `${canvasContext.edges.length} edges`,
        `${canvasContext.selectedNodes.length} selected`,
        canvasContext.recentActions.length > 0
          ? `last action: ${canvasContext.recentActions[canvasContext.recentActions.length - 1].action}`
          : 'no recent actions',
      ].join(', ');

      set({ contextSummary: summary, canvasContext });

      // Stream candidates one-by-one as they arrive from the LLM
      await recognizeIntentStream(canvasContext, (candidate) => {
        const { candidates: current } = get();
        set({ candidates: [...current, candidate], isLoading: false });
      });

      // Mark streaming as done when stream completes
      set({ isLoading: false, isStreaming: false });
    } catch (err) {
      console.error('[Intent Recognition] Failed:', err);
      set({
        candidates: [],
        isLoading: false,
        isStreaming: false,
        isOpen: false,
      });
    }
  },

  selectCandidate: async (index: number) => {
    const { candidates, canvasContext, selectedIndex, customIntent, actions } =
      get();
    const candidate = candidates[index];
    if (!candidate || !canvasContext) return;

    // Save current actions to cache before switching
    if (actions.length > 0) {
      const key = cacheKey(selectedIndex, candidates, customIntent);
      actionCache.set(key, { actions, original: [...originalActions] });
    }

    // Check cache for the target intent
    const targetKey = cacheKey(index, candidates, '');
    const cached = actionCache.get(targetKey);
    if (cached) {
      originalActions = cached.original;
      set({
        selectedIndex: index,
        actions: cached.actions,
        step: 'action-review',
      });
      return;
    }

    set({ selectedIndex: index, isLoading: true });

    try {
      const response = await resolveActions(canvasContext, candidate.label);
      originalActions = response.actions;
      const resolved = response.actions;
      actionCache.set(targetKey, {
        actions: resolved,
        original: [...resolved],
      });
      set({
        actions: resolved,
        step: 'action-review',
        isLoading: false,
      });
    } catch (err) {
      console.error('[Intent] Action resolution failed:', err);
      set({ isLoading: false });
    }
  },

  submitCustomIntent: async (text: string) => {
    const {
      canvasContext,
      selectedIndex,
      candidates,
      customIntent: prevCustom,
      actions,
    } = get();
    if (!text.trim() || !canvasContext) return;

    // Save current actions to cache before switching
    if (actions.length > 0) {
      const key = cacheKey(selectedIndex, candidates, prevCustom);
      actionCache.set(key, { actions, original: [...originalActions] });
    }

    // Check cache
    const targetKey = `custom:${text.trim()}`;
    const cached = actionCache.get(targetKey);
    if (cached) {
      originalActions = cached.original;
      set({
        customIntent: text,
        selectedIndex: -1,
        actions: cached.actions,
        step: 'action-review',
      });
      return;
    }

    set({ customIntent: text, selectedIndex: -1, isLoading: true });

    try {
      const response = await resolveActions(canvasContext, text.trim());
      originalActions = response.actions;
      const resolved = response.actions;
      actionCache.set(targetKey, {
        actions: resolved,
        original: [...resolved],
      });
      set({
        actions: resolved,
        step: 'action-review',
        isLoading: false,
      });
    } catch (err) {
      console.error('[Intent] Custom action resolution failed:', err);
      set({ isLoading: false });
    }
  },

  setCustomIntent: (text: string) => {
    set({ customIntent: text });
  },

  updateAction: (actionIndex: number, updated: IntentAction) => {
    const { actions } = get();
    const next = [...actions];
    next[actionIndex] = updated;
    set({ actions: next });
  },

  resetActions: () => {
    set({ actions: [...originalActions] });
  },

  goBack: () => {
    // Save current actions to cache before going back
    const { selectedIndex, candidates, customIntent, actions } = get();
    if (actions.length > 0) {
      const key = cacheKey(selectedIndex, candidates, customIntent);
      actionCache.set(key, { actions, original: [...originalActions] });
    }
    set({
      step: 'intent-select',
    });
  },

  execute: () => {
    const { actions, candidates, selectedIndex, customIntent, contextSummary } =
      get();

    const chosenLabel =
      selectedIndex >= 0
        ? (candidates[selectedIndex]?.label ?? 'unknown')
        : customIntent || 'custom intent';

    console.log(
      `[Intent] Executing: "${chosenLabel}" with ${actions.length} action(s)`,
      actions,
    );

    if (actions.length > 0) {
      try {
        executeIntentActions(actions);
        console.log('[Intent] All actions executed successfully');
      } catch (err) {
        console.error('[Intent] Action execution failed:', err);
      }
    }

    void logIntentEpisode({
      id: createId('intent'),
      timestamp: Date.now(),
      contextSummary,
      candidates,
      outcome: {
        type: 'selected',
        chosenIndex: selectedIndex >= 0 ? selectedIndex : 0,
        chosenLabel,
      },
    });

    set({
      isOpen: false,
      candidates: [],
      position: null,
      actions: [],
      step: 'intent-select',
      selectedIndex: -1,
      customIntent: '',
      canvasContext: null,
      isStreaming: false,
    });
  },

  dismiss: () => {
    const { candidates, contextSummary } = get();

    if (candidates.length > 0) {
      void logIntentEpisode({
        id: createId('intent'),
        timestamp: Date.now(),
        contextSummary,
        candidates,
        outcome: { type: 'dismissed' },
      });
    }

    set({
      isOpen: false,
      candidates: [],
      position: null,
      isLoading: false,
      isStreaming: false,
      actions: [],
      step: 'intent-select',
      selectedIndex: -1,
      customIntent: '',
      canvasContext: null,
    });
  },
}));
