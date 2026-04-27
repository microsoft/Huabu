/**
 * Intent recognition store.
 *
 * Single-step intent flow:
 *   Show intent candidates + custom input, let user pick one.
 *   The chosen intent is sent to the chat panel in operate mode for execution.
 */

import { createId, rectCenter } from '@sediment/shared';
import { create } from 'zustand';

import { captureCanvasScreenshot } from '@/handler/canvasCommand/utils/screenshot';
import {
  clusterAnnotations,
  classifyShape,
  extractAnnotationContext,
  resolveByRules,
} from '@/utils/annotation';

import useCanvasStore from './canvasStore';
import {
  recognizeIntentStream,
  recognizeAnnotationIntentStream,
  logIntentEpisode,
} from '../api/intent';

import type {
  AnnotationStroke,
  AnnotationContext,
  NearbyNodeInfo,
  ResolvedAnnotationIntent,
} from '@/utils/annotation';
import type {
  IntentCandidate,
  AnnotationClusterContext,
  AnnotationNearbyNode,
} from '@sediment/shared';
import type { Node } from '@xyflow/react';

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
    _annotationAbortController?.abort();
    _annotationAbortController = null;
    set({ pendingAnnotationIds: [] });
  },
}));

// ---------------------------------------------------------------------------
// Annotation recognition — three-stage pipeline
//
// Stage 1: Cluster annotation strokes spatially
// Stage 2: Classify each cluster's shape + extract nearby node context
// Stage 3: Rule-based fast path OR LLM fallback for each cluster
// ---------------------------------------------------------------------------

/** Abort controller for in-flight LLM annotation requests. */
let _annotationAbortController: AbortController | null = null;

/**
 * Build AnnotationStroke descriptors from annotation node IDs.
 */
function collectStrokes(
  annotationIds: string[],
  nodes: Node[],
): AnnotationStroke[] {
  const strokes: AnnotationStroke[] = [];
  for (const id of annotationIds) {
    const node = nodes.find((n) => n.id === id && n.type === 'annotation');
    if (!node) continue;

    const data = node.data as Record<string, unknown>;
    const points = (data.points as number[][]) ?? [];
    const initialSize = (data.initialSize as {
      width: number;
      height: number;
    }) ?? {
      width: 0,
      height: 0,
    };

    const w =
      (node.measured?.width ?? (node.style?.width as number | undefined)) ||
      initialSize.width;
    const h =
      (node.measured?.height ?? (node.style?.height as number | undefined)) ||
      initialSize.height;

    strokes.push({
      id,
      rect: { x: node.position.x, y: node.position.y, width: w, height: h },
      points,
      initialSize,
    });
  }
  return strokes;
}

/**
 * Convert an AnnotationContext to the shared AnnotationClusterContext type
 * for sending to the server.
 */
function toClusterContextPayload(
  ctx: AnnotationContext,
): AnnotationClusterContext {
  const center = rectCenter(ctx.cluster.bbox);
  const mapNode = (n: NearbyNodeInfo): AnnotationNearbyNode => ({
    id: n.id,
    type: n.type,
    label: n.label,
    position: n.position,
    size: n.size,
    distance: Math.round(n.distance),
    direction: n.direction,
  });

  return {
    shapeType: ctx.shape.type,
    shapeConfidence: ctx.shape.confidence,
    position: { x: Math.round(center.x), y: Math.round(center.y) },
    nearbyNodes: ctx.nearbyNodes.map(mapNode),
    enclosedNodes: ctx.enclosedNodes.map(mapNode),
    startNode: ctx.startNode ? mapNode(ctx.startNode) : undefined,
    endNode: ctx.endNode ? mapNode(ctx.endNode) : undefined,
  };
}

/**
 * Process a single annotation cluster through Stage 3 (LLM fallback).
 */
async function resolveByLLM(
  ctx: AnnotationContext,
  screenshot: string,
  signal: AbortSignal,
): Promise<ResolvedAnnotationIntent | null> {
  const candidates: IntentCandidate[] = [];

  await recognizeAnnotationIntentStream(
    screenshot,
    ctx.cluster.strokeIds,
    toClusterContextPayload(ctx),
    (candidate) => {
      candidates.push(candidate);
    },
    signal,
  );

  if (candidates.length === 0) return null;

  const center = rectCenter(ctx.cluster.bbox);
  return {
    label: candidates[0].label,
    source: 'llm',
    cluster: ctx.cluster,
    position: { x: Math.round(center.x), y: Math.round(center.y) },
  };
}

async function triggerAnnotationRecognition(
  get: () => IntentState,
  set: (partial: Partial<IntentState>) => void,
): Promise<void> {
  const { pendingAnnotationIds, _onIntentChosen } = get();
  if (pendingAnnotationIds.length === 0) return;

  // Grab the batch and clear
  const annotationIds = [...pendingAnnotationIds];
  set({ pendingAnnotationIds: [] });

  // Abort any previously in-flight annotation LLM request
  _annotationAbortController?.abort();
  _annotationAbortController = new AbortController();
  const { signal } = _annotationAbortController;

  const { nodes } = useCanvasStore.getState();

  // ── Stage 1: Cluster ──────────────────────────────────────────
  const strokes = collectStrokes(annotationIds, nodes);
  if (strokes.length === 0) return;

  const clusters = clusterAnnotations(strokes);

  // ── Stage 2: Classify + extract context ───────────────────────
  const contextsByCluster: AnnotationContext[] = clusters.map((cluster) => {
    const shape = classifyShape(cluster);
    return extractAnnotationContext(cluster, shape, nodes);
  });

  // ── Stage 3: Resolve intents (rule-based fast path + LLM fallback) ──
  const resolvedIntents: ResolvedAnnotationIntent[] = [];
  const llmPending: AnnotationContext[] = [];

  for (const ctx of contextsByCluster) {
    const ruleResult = resolveByRules(ctx);
    if (ruleResult) {
      resolvedIntents.push(ruleResult);
    } else {
      llmPending.push(ctx);
    }
  }

  // LLM fallback for clusters the rule engine couldn't resolve
  if (llmPending.length > 0 && !signal.aborted) {
    try {
      // Capture screenshot only when LLM is actually needed
      const screenshot = await captureCanvasScreenshot({ stripPrefix: true });
      if (screenshot && !signal.aborted) {
        // Process LLM clusters sequentially to avoid overwhelming the server
        for (const ctx of llmPending) {
          if (signal.aborted) break;
          const result = await resolveByLLM(ctx, screenshot, signal);
          if (result) resolvedIntents.push(result);
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('[Annotation Intent] LLM fallback failed:', err);
      }
    }
  }

  // All annotation node IDs across all clusters
  const allAnnotationIds = clusters.flatMap((c) => c.strokeIds);

  // Send resolved intents to the operate agent
  if (resolvedIntents.length > 0 && _onIntentChosen && !signal.aborted) {
    try {
      const combinedLabel = resolvedIntents.map((r) => r.label).join('\n');
      const candidates: IntentCandidate[] = resolvedIntents.map((r) => ({
        label: r.label,
        description: `source: ${r.source}`,
      }));

      // Await the operate agent to fully complete before deleting annotations
      await _onIntentChosen(combinedLabel, candidates);
    } catch (err) {
      console.error('[Annotation Intent] Operate agent failed:', err);
    }
  }

  // Delete annotation nodes LAST — after operate agent has finished
  useCanvasStore.getState().deleteNodes(allAnnotationIds);
}
