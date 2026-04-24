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
  recognizeAnnotationIntentStream,
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

  // ── Annotation recognition ──
  /** Annotation node IDs waiting for the 5 s idle timer. */
  pendingAnnotationIds: string[];
  /** Called by AnnotationOverlay after each stroke finishes. Resets the 5 s idle timer. */
  onAnnotationCreated: (annotationNodeId: string) => void;
  /** Cancel any pending annotation recognition (e.g. user switches away from annotation tool). */
  cancelAnnotationRecognition: () => void;

  /**
   * Callback set by ChatPanel to receive chosen intents.
   * @internal — not for external use.
   */
  _onIntentChosen:
    | ((intent: string, candidates: IntentCandidate[]) => Promise<void> | void)
    | null;
  _setOnIntentChosen: (
    cb:
      | ((
          intent: string,
          candidates: IntentCandidate[],
        ) => Promise<void> | void)
      | null,
  ) => void;
}

/** Idle time (ms) after the last annotation stroke before triggering recognition. */
const ANNOTATION_RECOGNITION_DELAY_MS = 3_000;
let _annotationTimer: ReturnType<typeof setTimeout> | null = null;

export const useIntentStore = create<IntentState>()((set, get) => ({
  isOpen: false,
  isLoading: false,
  isStreaming: false,
  candidates: [],
  selectedIndex: -1,
  customIntent: '',
  position: null,
  contextSummary: '',
  pendingAnnotationIds: [],

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

  // ── Annotation recognition ────────────────────────────────────────

  onAnnotationCreated: (annotationNodeId: string) => {
    const current = get().pendingAnnotationIds;
    if (!current.includes(annotationNodeId)) {
      set({ pendingAnnotationIds: [...current, annotationNodeId] });
    }

    // Reset the 5 s idle timer
    if (_annotationTimer) clearTimeout(_annotationTimer);
    _annotationTimer = setTimeout(() => {
      _annotationTimer = null;
      void triggerAnnotationRecognition(get, set);
    }, ANNOTATION_RECOGNITION_DELAY_MS);
  },

  cancelAnnotationRecognition: () => {
    if (_annotationTimer) {
      clearTimeout(_annotationTimer);
      _annotationTimer = null;
    }
    set({ pendingAnnotationIds: [] });
  },
}));

// ---------------------------------------------------------------------------
// Annotation recognition — runs after 5 s idle, auto-sends to chat panel
// ---------------------------------------------------------------------------

async function triggerAnnotationRecognition(
  get: () => IntentState,
  set: (partial: Partial<IntentState>) => void,
): Promise<void> {
  const { pendingAnnotationIds, _onIntentChosen } = get();
  if (pendingAnnotationIds.length === 0) return;

  // Grab the batch and clear
  const annotationIds = [...pendingAnnotationIds];
  set({ pendingAnnotationIds: [] });

  // Verify the annotation nodes still exist on canvas
  const { nodes } = useCanvasStore.getState();
  const existingIds = annotationIds.filter((id) =>
    nodes.some((n) => n.id === id && n.type === 'annotation'),
  );
  if (existingIds.length === 0) return;

  // Save annotation positions BEFORE they get deleted — used to inject
  // coordinates into the intent label so the operate agent knows WHERE
  // to place new nodes (e.g. CREATE_QUESTION at the annotation's spot).
  const annotationPositions = new Map<string, { x: number; y: number }>();
  for (const id of existingIds) {
    const node = nodes.find((n) => n.id === id);
    if (node) {
      annotationPositions.set(id, { ...node.position });
    }
  }

  try {
    // Capture screenshot BEFORE deleting annotations — the vision model needs to see them
    const screenshot = await captureCanvasScreenshot({ stripPrefix: true });
    if (!screenshot) return;

    // Stream annotation intent candidates (typically just one)
    const candidates: IntentCandidate[] = [];

    await recognizeAnnotationIntentStream(
      screenshot,
      existingIds,
      (candidate) => {
        candidates.push(candidate);
      },
    );

    // Inject annotation positions into ALL candidate labels so the operate
    // agent can place new nodes (e.g. question) at the drawn location.
    // Replace "CREATE_QUESTION at node-xxx" with "CREATE_QUESTION at position {x,y}".
    if (candidates.length > 0 && _onIntentChosen) {
      const processedLabels: string[] = [];
      for (const candidate of candidates) {
        let label = candidate.label;
        for (const [id, pos] of annotationPositions) {
          const shortId = id.slice(0, 18);
          if (label.includes(id)) {
            label = label.replace(
              id,
              `position {x:${Math.round(pos.x)},y:${Math.round(pos.y)}}`,
            );
          } else if (label.includes(shortId)) {
            label = label.replace(
              shortId,
              `position {x:${Math.round(pos.x)},y:${Math.round(pos.y)}}`,
            );
          }
        }
        processedLabels.push(label);
      }

      // Combine all intents into a single message so the operate agent
      // executes them all in one batch.
      const combinedLabel = processedLabels.join('\n');
      // Await the operate agent to fully complete before deleting annotations.
      await _onIntentChosen(combinedLabel, candidates);
    }

    // Delete annotation nodes LAST — after operate agent has finished execution
    useCanvasStore.getState().deleteNodes(existingIds);
  } catch (err) {
    console.error('[Annotation Intent Recognition] Failed:', err);
    // Delete annotation nodes even on failure — they should not persist
    useCanvasStore.getState().deleteNodes(existingIds);
  }
}
