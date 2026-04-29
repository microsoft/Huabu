/**
 * Intent recognition store.
 *
 * Single-step intent flow:
 *   Show intent candidates + custom input, let user pick one.
 *   The chosen intent is sent to the chat panel in operate mode for execution.
 */

import { createId, rectCenter } from '@sediment/shared';
import { create } from 'zustand';

import {
  clusterAnnotations,
  classifyShape,
  extractAnnotationContext,
  resolveByRules,
} from '@/handler/annotation';
import { captureCanvasScreenshot } from '@/handler/canvasCommand/utils/screenshot';
import { snapshotAndExtractChanges } from '@/hooks/useCanvasChanges';

import useCanvasStore from './canvasStore';
import {
  recognizeIntentStream,
  recognizeAnnotationCommands,
  logIntentEpisode,
} from '../api/intent';

import type { CanvasChange } from '@/hooks/useCanvasChanges';
import type {
  AnnotationStroke,
  AnnotationContext,
  AnnotationCluster,
  AnnotationNearbyNode,
  ResolvedAnnotationIntent,
  CanvasCommand,
  CanvasNodeId,
  IntentCandidate,
  AnnotationClusterContext,
  AnnotationNearbyEdge,
} from '@sediment/shared';
import type { Node } from '@xyflow/react';

/**
 * Lifecycle status for an annotation cluster currently being recognised.
 *
 * - `preparing` — user is still drawing; idle timer not yet fired.
 * - `pending`   — idle timer fired; running rule resolution + screenshot capture.
 * - `running`   — LLM request is in flight (or commands are being applied).
 * - `done`      — finished; overlay stays visible until the next batch.
 */
export type AnnotationProcessingStatus =
  | 'preparing'
  | 'pending'
  | 'running'
  | 'done';

/** A single annotation cluster currently visible in the processing overlay. */
export interface AnnotationProcessingCluster {
  /** Stable id derived from the cluster's annotation node ids. */
  id: string;
  /** Annotation node ids contained in this cluster. */
  strokeIds: string[];
  status: AnnotationProcessingStatus;
  /**
   * Canvas changes produced by this cluster's intent commands. Captured at
   * recognition time (pre-execution) so each entry carries its revert data.
   * Only populated once `status === 'done'`.
   */
  changes?: CanvasChange[];
}

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
  /** Clusters currently being processed; drives the on-canvas overlay. */
  processingClusters: AnnotationProcessingCluster[];
  /** Called by AnnotationOverlay after each stroke finishes. Resets the 5 s idle timer. */
  onAnnotationCreated: (annotationNodeId: string) => void;
  /** Cancel any pending annotation recognition (e.g. user switches away from annotation tool). */
  cancelAnnotationRecognition: () => void;
  /**
   * Keep the cluster's intent commands and remove both the overlay and the
   * annotation strokes from the canvas.
   */
  acceptCluster: (clusterId: string) => void;
  /**
   * Revert the cluster's intent commands to restore the canvas state, then
   * remove both the overlay and the annotation strokes from the canvas.
   */
  revertCluster: (clusterId: string) => void;

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
  processingClusters: [],

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
    const state = get();
    const current = state.pendingAnnotationIds;
    const nextPending = current.includes(annotationNodeId)
      ? current
      : [...current, annotationNodeId];

    // If a previous batch finished and is still showing 'done' overlays,
    // wipe them now — the user is starting a fresh gesture.
    const prevDoneOnly =
      state.processingClusters.length > 0 &&
      state.processingClusters.every((c) => c.status === 'done');
    const baseClusters = prevDoneOnly ? [] : state.processingClusters;

    // Recompute overlay clusters from the live pending stroke set so the
    // overlay grows immediately as the user keeps drawing.
    const { nodes } = useCanvasStore.getState();
    const strokes = collectStrokes(nextPending, nodes);
    const clusters = clusterAnnotations(strokes);

    // Preserve status from existing clusters keyed by stroke ids; new
    // clusters start in 'preparing' (user is still drawing).
    const prevById = new Map(baseClusters.map((c) => [c.id, c]));
    const nextProcessing: AnnotationProcessingCluster[] = clusters.map((c) => {
      const id = clusterKey(c);
      const prev = prevById.get(id);
      return {
        id,
        strokeIds: c.strokeIds,
        // Preserve a non-preparing status if a re-cluster overlaps it; otherwise
        // the user is still drawing → 'preparing'.
        status: prev && prev.status !== 'preparing' ? prev.status : 'preparing',
      };
    });

    set({
      pendingAnnotationIds: nextPending,
      processingClusters: nextProcessing,
    });

    // Reset the idle timer
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
    set({ pendingAnnotationIds: [], processingClusters: [] });
  },

  acceptCluster: (clusterId: string) => {
    const cluster = get().processingClusters.find((c) => c.id === clusterId);
    if (!cluster) return;

    // Drop the strokes themselves so the grey gesture also disappears.
    if (cluster.strokeIds.length > 0) {
      useCanvasStore.getState().executeCommands(
        [
          {
            type: 'DELETE_NODES',
            nodeIds: cluster.strokeIds as CanvasNodeId[],
          },
        ],
        'ui',
      );
    }

    set({
      processingClusters: get().processingClusters.filter(
        (c) => c.id !== clusterId,
      ),
    });
  },

  revertCluster: (clusterId: string) => {
    const cluster = get().processingClusters.find((c) => c.id === clusterId);
    if (!cluster) return;

    // Walk changes in reverse order, collecting any revert commands that
    // were captured before the original intent commands ran.
    const revertCmds: CanvasCommand[] = [];
    const changes = cluster.changes ?? [];
    for (let i = changes.length - 1; i >= 0; i--) {
      const c = changes[i];
      if (!c?.revertible) continue;
      if (c.revertCommands) revertCmds.push(...c.revertCommands);
      else if (c.revertCommand) revertCmds.push(c.revertCommand);
    }

    // Always also delete the annotation strokes themselves on revert.
    if (cluster.strokeIds.length > 0) {
      revertCmds.push({
        type: 'DELETE_NODES',
        nodeIds: cluster.strokeIds as CanvasNodeId[],
      });
    }

    if (revertCmds.length > 0) {
      useCanvasStore.getState().executeCommands(revertCmds, 'ui');
    }

    set({
      processingClusters: get().processingClusters.filter(
        (c) => c.id !== clusterId,
      ),
    });
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

/** Stable id for a cluster derived from its annotation node ids. */
function clusterKey(cluster: AnnotationCluster): string {
  return cluster.strokeIds.slice().sort().join('|');
}

/**
 * Build AnnotationStroke descriptors from annotation node IDs.
 * Positions are converted to absolute flow coordinates by walking up the
 * parent chain, so strokes drawn on top of frames / parented nodes still
 * report a correctly-placed bounding box.
 */
function collectStrokes(
  annotationIds: string[],
  nodes: Node[],
): AnnotationStroke[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const absoluteOffset = (n: Node): { x: number; y: number } => {
    let dx = 0;
    let dy = 0;
    let cur: Node | undefined = n;
    while (cur) {
      dx += cur.position.x;
      dy += cur.position.y;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return { x: dx, y: dy };
  };

  const strokes: AnnotationStroke[] = [];
  for (const id of annotationIds) {
    const node = byId.get(id);
    if (!node || node.type !== 'annotation') continue;

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

    const abs = absoluteOffset(node);
    strokes.push({
      id,
      rect: { x: abs.x, y: abs.y, width: w, height: h },
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
  const mapNode = (n: AnnotationNearbyNode): AnnotationNearbyNode => ({
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
    nearbyEdges: ctx.nearbyEdges.map(
      (e): AnnotationNearbyEdge => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceLabel: e.sourceLabel,
        targetLabel: e.targetLabel,
        distance: Math.round(e.distance),
      }),
    ),
    startNode: ctx.startNode ? mapNode(ctx.startNode) : undefined,
    endNode: ctx.endNode ? mapNode(ctx.endNode) : undefined,
  };
}

/**
 * Process a single annotation cluster through Stage 3 (LLM fallback).
 * Returns directly executable CanvasCommand[].
 */
async function resolveByLLM(
  ctx: AnnotationContext,
  screenshot: string,
  signal: AbortSignal,
): Promise<ResolvedAnnotationIntent | null> {
  const response = await recognizeAnnotationCommands(
    screenshot,
    toClusterContextPayload(ctx),
    signal,
  );

  if (!response.commands || response.commands.length === 0) return null;

  return {
    commands: response.commands,
    reasoning: response.reasoning,
    source: 'llm',
    cluster: ctx.cluster,
  };
}

async function triggerAnnotationRecognition(
  get: () => IntentState,
  set: (partial: Partial<IntentState>) => void,
): Promise<void> {
  const { pendingAnnotationIds } = get();
  if (pendingAnnotationIds.length === 0) return;

  // Grab the batch and clear
  const annotationIds = [...pendingAnnotationIds];
  set({ pendingAnnotationIds: [] });

  // Abort any previously in-flight annotation LLM request
  _annotationAbortController?.abort();
  _annotationAbortController = new AbortController();
  const { signal } = _annotationAbortController;

  const { nodes, edges } = useCanvasStore.getState();

  // ── Stage 1: Cluster ──────────────────────────────────────────
  const strokes = collectStrokes(annotationIds, nodes);
  if (strokes.length === 0) return;

  const clusters = clusterAnnotations(strokes);
  // Refresh the overlay clusters and flip them to 'pending' — the idle timer
  // has fired, so we are now actively preparing the request.
  const initialProcessing: AnnotationProcessingCluster[] = clusters.map(
    (c) => ({
      id: clusterKey(c),
      strokeIds: c.strokeIds,
      status: 'pending',
    }),
  );
  set({ processingClusters: initialProcessing });
  // ── Stage 2: Classify + extract context ───────────────────────
  const contextsByCluster: AnnotationContext[] = clusters.map((cluster) => {
    const shape = classifyShape(cluster);
    return extractAnnotationContext(cluster, shape, nodes, edges);
  });

  // ── Stage 3: Resolve intents (rule-based fast path + LLM fallback) ──
  // Track which cluster each resolved intent belongs to so we can later
  // attribute generated CanvasChanges back to the originating overlay.
  const resolvedIntents: Array<{
    clusterId: string;
    intent: ResolvedAnnotationIntent;
  }> = [];
  const llmPending: Array<{ clusterId: string; ctx: AnnotationContext }> = [];

  for (const ctx of contextsByCluster) {
    const cid = clusterKey(ctx.cluster);
    const ruleResult = resolveByRules(ctx);
    if (ruleResult) {
      resolvedIntents.push({ clusterId: cid, intent: ruleResult });
    } else {
      llmPending.push({ clusterId: cid, ctx });
    }
  }

  // LLM fallback for clusters the rule engine couldn't resolve
  if (llmPending.length > 0 && !signal.aborted) {
    try {
      // Switch all clusters to 'running' the moment we start preparing
      // per-cluster screenshots and firing requests.
      set({
        processingClusters: get().processingClusters.map((c) => ({
          ...c,
          status: 'running',
        })),
      });
      // Process LLM clusters sequentially. Each cluster shares the same
      // viewport screenshot for now; per-cluster bbox highlighting and edge
      // re-drawing are not yet wired through `captureCanvasScreenshot`.
      for (const { clusterId: cid, ctx } of llmPending) {
        if (signal.aborted) break;
        const screenshot = await captureCanvasScreenshot({
          stripPrefix: true,
        });
        if (!screenshot || signal.aborted) continue;
        const result = await resolveByLLM(ctx, screenshot, signal);
        if (result) resolvedIntents.push({ clusterId: cid, intent: result });
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('[Annotation Intent] LLM fallback failed:', err);
      }
    }
  }

  if (signal.aborted) {
    // A newer batch (or user cancel) superseded us — leave any existing
    // overlay state to whoever caused the abort.
    return;
  }

  // All annotation node IDs across all clusters
  const allAnnotationIds = clusters.flatMap((c) => c.strokeIds);

  // Capture per-cluster CanvasChanges BEFORE executing anything, so each
  // entry's revert data reflects the canvas state that existed prior to the
  // intent batch. The strokes' `executed: true` marker is appended to the
  // execution batch separately and intentionally excluded from change
  // capture (it's internal bookkeeping, not a user-facing change).
  const changesByCluster = new Map<string, CanvasChange[]>();
  for (const { clusterId: cid, intent } of resolvedIntents) {
    if (intent.commands.length === 0) continue;
    const captured = snapshotAndExtractChanges(intent.commands);
    const existing = changesByCluster.get(cid) ?? [];
    changesByCluster.set(cid, [...existing, ...captured]);
  }

  // Aggregate all resolved commands and execute atomically as one batch.
  // Mark the annotation strokes as `executed` (instead of deleting them) so
  // the user can still see the gesture they drew. The AnnotationNode renderer
  // dims executed strokes to a faint grey.
  const allCommands: CanvasCommand[] = resolvedIntents.flatMap(
    (r) => r.intent.commands,
  );

  if (allAnnotationIds.length > 0) {
    allCommands.push({
      type: 'MERGE_NODE_DATA',
      patches: allAnnotationIds.map((id) => ({
        nodeId: id as never,
        patch: { executed: true },
      })),
    });
  }

  if (allCommands.length > 0) {
    if (resolvedIntents.length > 0) {
      console.log(
        '[Annotation Intent] Executing',
        resolvedIntents.length,
        'resolved intent(s):',
        resolvedIntents
          .map((r) => `[${r.intent.source}] ${r.intent.reasoning}`)
          .join(' | '),
      );
    }

    // For rule-only batches the overlay is still in 'pending' — promote to
    // 'running' for the brief duration of executeCommands so the user sees
    // the same lifecycle.
    set({
      processingClusters: get().processingClusters.map((c) =>
        c.status === 'pending' || c.status === 'preparing'
          ? { ...c, status: 'running' }
          : c,
      ),
    });

    useCanvasStore.getState().executeCommands(allCommands, 'agent');
  }

  // Mark all clusters 'done' and attach their captured changes so the
  // overlay can render accept/revert/blend buttons. Overlays linger on the
  // canvas until the user resolves them or the next batch starts.
  set({
    processingClusters: get().processingClusters.map((c) => ({
      ...c,
      status: 'done',
      changes: changesByCluster.get(c.id) ?? c.changes,
    })),
  });
}
