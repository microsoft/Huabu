/**
 * Intent recognition store.
 *
 * Single-step intent flow:
 *   Show intent candidates + custom input, let user pick one.
 *   The chosen intent is sent to the chat panel in operate mode for execution.
 */

import { createId } from '@sediment/shared';
import { create } from 'zustand';

import { captureCanvasScreenshot } from '@/handler/canvasCommand/utils/screenshot';

import useCanvasStore from './canvasStore';
import {
  recognizeIntentStream,
  recognizeSketchIntentStream,
  logIntentEpisode,
} from '../api/intent';

import type { IntentCandidate } from '@sediment/shared';

interface IntentState {
  isOpen: boolean;
  isLoading: boolean;
  /** True while the LLM is still streaming candidates (candidates may already be partially available) */
  isStreaming: boolean;
  /** Intent candidates */
  candidates: IntentCandidate[];
  /** Index of the selected candidate (or -1 for custom) */
  selectedIndex: number;
  /** Custom intent typed by user */
  customIntent: string;
  position: { x: number; y: number } | null;
  contextSummary: string;

  triggerIntent: (mouseX: number, mouseY: number) => Promise<void>;
  /** Select an intent candidate → send to chat panel as agent message */
  selectCandidate: (index: number) => void;
  /** Submit custom intent text → send to chat panel as agent message */
  submitCustomIntent: (text: string) => void;
  setCustomIntent: (text: string) => void;
  dismiss: () => void;

  // ── Sketch recognition ──
  /** Sketch node IDs waiting for the 10 s idle timer. */
  pendingSketchIds: string[];
  /** Called by SketchOverlay after each stroke finishes. Resets the 10 s idle timer. */
  onSketchCreated: (sketchNodeId: string) => void;
  /** Cancel any pending sketch recognition (e.g. user switches away from sketch tool). */
  cancelSketchRecognition: () => void;

  /**
   * Callback set by ChatPanel to receive chosen intents.
   * @internal — not for external use.
   */
  _onIntentChosen:
    | ((intent: string, candidates: IntentCandidate[]) => void)
    | null;
  _setOnIntentChosen: (
    cb: ((intent: string, candidates: IntentCandidate[]) => void) | null,
  ) => void;
}

/** Idle time (ms) after the last sketch stroke before triggering recognition. */
const SKETCH_RECOGNITION_DELAY_MS = 5_000;
let _sketchTimer: ReturnType<typeof setTimeout> | null = null;

export const useIntentStore = create<IntentState>()((set, get) => ({
  isOpen: false,
  isLoading: false,
  isStreaming: false,
  candidates: [],
  selectedIndex: -1,
  customIntent: '',
  position: null,
  contextSummary: '',
  pendingSketchIds: [],

  _onIntentChosen: null,
  _setOnIntentChosen: (cb) => set({ _onIntentChosen: cb }),

  triggerIntent: async (mouseX, mouseY) => {
    set({
      isLoading: true,
      isStreaming: true,
      isOpen: true,
      position: { x: mouseX, y: mouseY },
      candidates: [],
      selectedIndex: -1,
      customIntent: '',
      contextSummary: '',
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

      set({ contextSummary: summary });

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

  selectCandidate: (index: number) => {
    const { candidates, contextSummary, _onIntentChosen } = get();
    const candidate = candidates[index];
    if (!candidate) return;

    const chosenLabel = candidate.label;
    // Preserve candidates before clearing state
    const savedCandidates = [...candidates];
    const canvasId = useCanvasStore.getState().canvasId;

    void logIntentEpisode(
      {
        id: createId('intent'),
        timestamp: Date.now(),
        contextSummary,
        candidates,
        outcome: {
          type: 'selected',
          chosenIndex: index,
          chosenLabel,
        },
      },
      canvasId || undefined,
    );

    // Dismiss popover and send to chat panel
    set({
      isOpen: false,
      candidates: [],
      position: null,
      selectedIndex: -1,
      customIntent: '',
      isStreaming: false,
    });

    _onIntentChosen?.(chosenLabel, savedCandidates);
  },

  submitCustomIntent: (text: string) => {
    if (!text.trim()) return;
    const { candidates, contextSummary, _onIntentChosen } = get();
    const canvasId = useCanvasStore.getState().canvasId;

    void logIntentEpisode(
      {
        id: createId('intent'),
        timestamp: Date.now(),
        contextSummary,
        candidates,
        outcome: {
          type: 'selected',
          chosenIndex: 0,
          chosenLabel: text.trim(),
        },
      },
      canvasId || undefined,
    );

    // Preserve candidates before clearing state
    const savedCandidates = [...candidates];

    // Dismiss popover and send to chat panel
    set({
      isOpen: false,
      candidates: [],
      position: null,
      selectedIndex: -1,
      customIntent: '',
      isStreaming: false,
    });

    _onIntentChosen?.(text.trim(), savedCandidates);
  },

  setCustomIntent: (text: string) => {
    set({ customIntent: text });
  },

  dismiss: () => {
    const { candidates, contextSummary } = get();

    if (candidates.length > 0) {
      const canvasId = useCanvasStore.getState().canvasId;
      void logIntentEpisode(
        {
          id: createId('intent'),
          timestamp: Date.now(),
          contextSummary,
          candidates,
          outcome: { type: 'dismissed' },
        },
        canvasId || undefined,
      );
    }

    set({
      isOpen: false,
      candidates: [],
      position: null,
      isLoading: false,
      isStreaming: false,
      selectedIndex: -1,
      customIntent: '',
    });
  },

  // ── Sketch recognition ────────────────────────────────────────

  onSketchCreated: (sketchNodeId: string) => {
    const current = get().pendingSketchIds;
    if (!current.includes(sketchNodeId)) {
      set({ pendingSketchIds: [...current, sketchNodeId] });
    }

    // Reset the 5 s idle timer
    if (_sketchTimer) clearTimeout(_sketchTimer);
    _sketchTimer = setTimeout(() => {
      _sketchTimer = null;
      void triggerSketchRecognition(get, set);
    }, SKETCH_RECOGNITION_DELAY_MS);
  },

  cancelSketchRecognition: () => {
    if (_sketchTimer) {
      clearTimeout(_sketchTimer);
      _sketchTimer = null;
    }
    set({ pendingSketchIds: [] });
  },
}));

// ---------------------------------------------------------------------------
// Sketch recognition — runs after 10 s idle, auto-sends to chat panel
// ---------------------------------------------------------------------------

async function triggerSketchRecognition(
  get: () => IntentState,
  set: (partial: Partial<IntentState>) => void,
): Promise<void> {
  const { pendingSketchIds, _onIntentChosen } = get();
  if (pendingSketchIds.length === 0) return;

  // Grab the batch and clear
  const sketchIds = [...pendingSketchIds];
  set({ pendingSketchIds: [] });

  // Verify the sketch nodes still exist on canvas
  const { nodes } = useCanvasStore.getState();
  const existingIds = sketchIds.filter((id) =>
    nodes.some((n) => n.id === id && n.type === 'sketch'),
  );
  if (existingIds.length === 0) return;

  try {
    // Capture screenshot only — the vision model reads everything from the image
    const screenshot = await captureCanvasScreenshot({ stripPrefix: true });
    if (!screenshot) return;

    // Stream sketch intent candidates (typically just one)
    const candidates: IntentCandidate[] = [];

    await recognizeSketchIntentStream(screenshot, existingIds, (candidate) => {
      candidates.push(candidate);
    });

    // Auto-execute: send the first candidate directly to chat panel
    const first = candidates[0];
    if (first && _onIntentChosen) {
      _onIntentChosen(first.label, candidates);
    }
  } catch (err) {
    console.error('[Sketch Intent Recognition] Failed:', err);
  }
}
