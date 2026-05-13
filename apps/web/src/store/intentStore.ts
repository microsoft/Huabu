/**
 * Intent recognition store.
 *
 * Single-step intent flow:
 *   Show intent candidates + custom input, let user pick one.
 *   The chosen intent is sent to the chat panel in operate mode for execution.
 */

import { createId } from '@sediment/shared';
import { create } from 'zustand';

import {
  clusterAnnotations,
  extractAnnotationContext,
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
  ResolvedAnnotationIntent,
  CanvasCommand,
  CanvasNodeId,
  IntentCandidate,
  AnnotationClusterContext,
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
  /** Resolution path. Always `'llm'` since the rule engine has been removed. */
  source?: 'llm';
  /** One-sentence reason describing what the user meant. */
  reasoning?: string;
  /** Raw canvas commands produced for this cluster. */
  commands?: CanvasCommand[];
  /** Short text summary of the nearby / enclosed nodes used as context. */
  contextSummary?: string;
  /** Canvas id this cluster was recognised against. */
  canvasId?: string;
  /** Set when LLM recognition failed for this cluster. */
  error?: string;
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
      // Flush buffered behavioural events first so the intent
      // recogniser sees the most up-to-date action history.
      await useCanvasStore.getState().flushCanvasEvents();

      const canvasContext = useCanvasStore.getState().getIntentContext();

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

    // Preserve any `done` overlays from previous batches — they carry the
    // only UI to Accept/Revert already-applied commands, so silently
    // dropping them would strand those changes on the canvas.
    const doneClusters = state.processingClusters.filter(
      (c) => c.status === 'done',
    );
    // Preserve in-progress clusters that belong to ALREADY-RUNNING batches.
    // Those batches cleared `pendingAnnotationIds` when they fired, so their
    // strokeIds are no longer in `nextPending`. They must not be dropped just
    // because the user kept drawing — only the live "preparing" cluster(s)
    // built from the current pending set should be recomputed below.
    const pendingSet = new Set(nextPending);
    const otherBatchInProgress = state.processingClusters.filter(
      (c) =>
        c.status !== 'done' && !c.strokeIds.some((id) => pendingSet.has(id)),
    );
    const prevInProgress = state.processingClusters.filter(
      (c) =>
        c.status !== 'done' && c.strokeIds.some((id) => pendingSet.has(id)),
    );

    // Recompute in-progress overlay clusters from the live pending stroke
    // set so the overlay grows immediately as the user keeps drawing.
    const { nodes } = useCanvasStore.getState();
    const strokes = collectStrokes(nextPending, nodes);
    const clusters = clusterAnnotations(strokes);

    // Preserve status from existing in-progress clusters keyed by stroke
    // ids; new clusters start in 'preparing' (user is still drawing).
    const prevById = new Map(prevInProgress.map((c) => [c.id, c]));
    const inProgress: AnnotationProcessingCluster[] = clusters.map((c) => {
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
      processingClusters: [
        ...doneClusters,
        ...otherBatchInProgress,
        ...inProgress,
      ],
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
    // Abort every currently in-flight batch and drop the registry.
    for (const ctrl of _activeRecognitions) ctrl.abort();
    _activeRecognitions.clear();
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
// Stage 2: Collect IDs of nearby/enclosed nodes + edges (no labels/positions)
// Stage 3: Send screenshot + IDs to the server-side LLM agent which fetches
//          additional node content on demand via `read` (markdown body),
//          node layout via `inspect_nodes` (canvas.json fields), and
//          edge style via `inspect_edges`.
//
// Each call to `triggerAnnotationRecognition` owns its own AbortController
// and runs independently of any other in-flight batches. Two consecutive
// batches can therefore execute in parallel — the second one does NOT cancel
// the first. Bulk cancellation (e.g. user leaves the annotation tool, canvas
// switch) goes through `cancelAnnotationRecognition`, which aborts every
// currently-registered controller.
// ---------------------------------------------------------------------------

/** Registry of in-flight recognition batches, one entry per active call. */
const _activeRecognitions: Set<AbortController> = new Set();

/** Stable id for a cluster derived from its annotation node ids. */
function clusterKey(cluster: AnnotationCluster): string {
  return cluster.strokeIds.slice().sort().join('|');
}

/**
 * Build a short human-readable summary of the spatial context used by the
 * resolver. Used by the cluster inspector to explain "what the AI saw".
 */
function buildContextSummary(ctx: AnnotationContext): string {
  const parts: string[] = [
    `Strokes: ${ctx.cluster.strokeIds.length}`,
    `Bbox: ${Math.round(ctx.cluster.bbox.width)}×${Math.round(ctx.cluster.bbox.height)}px`,
  ];
  const refLabel = (r: { label?: string; id: string }): string =>
    r.label && r.label.length > 0 ? r.label : r.id;
  if (ctx.enclosedNodes.length > 0) {
    parts.push(
      `Enclosed (${ctx.enclosedNodes.length}): ${ctx.enclosedNodes.slice(0, 5).map(refLabel).join(', ')}${ctx.enclosedNodes.length > 5 ? '…' : ''}`,
    );
  }
  if (ctx.nearbyNodes.length > 0) {
    parts.push(
      `Nearby nodes (${ctx.nearbyNodes.length}): ${ctx.nearbyNodes.slice(0, 5).map(refLabel).join(', ')}${ctx.nearbyNodes.length > 5 ? '…' : ''}`,
    );
  }
  if (ctx.nearbyEdgeIds.length > 0) {
    parts.push(`Nearby edges: ${ctx.nearbyEdgeIds.length}`);
  }
  return parts.join('\n');
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
 * Convert an AnnotationContext to the wire payload sent to the server.
 * Carries id+type+label refs for nodes (so the LLM doesn't need a `read`
 * round-trip just to know what each id refers to) and bare ids for
 * edges. The LLM still fetches body text via `read`, layout via
 * `inspect_nodes`, and edge style via `inspect_edges` on demand.
 */
function toClusterContextPayload(
  ctx: AnnotationContext,
): AnnotationClusterContext {
  return {
    bbox: {
      x: Math.round(ctx.cluster.bbox.x),
      y: Math.round(ctx.cluster.bbox.y),
      width: Math.round(ctx.cluster.bbox.width),
      height: Math.round(ctx.cluster.bbox.height),
    },
    strokeCount: ctx.cluster.strokeIds.length,
    nearbyNodes: ctx.nearbyNodes,
    enclosedNodes: ctx.enclosedNodes,
    nearbyEdgeIds: ctx.nearbyEdgeIds,
  };
}

/**
 * Send the cluster + screenshot to the server-side annotation agent and
 * return the executable command batch it produced.
 */
async function resolveByLLM(
  ctx: AnnotationContext,
  screenshot: string,
  signal: AbortSignal,
  canvasId?: string,
): Promise<ResolvedAnnotationIntent | null> {
  const response = await recognizeAnnotationCommands(
    screenshot,
    toClusterContextPayload(ctx),
    signal,
    canvasId,
  );

  // An empty `commands` array is a VALID outcome: the LLM understood the
  // gesture but decided no canvas mutation was warranted (e.g. an ambiguous
  // deletion stroke that doesn't clearly target any node). Surface the
  // reasoning so the detail panel can show what the LLM thought, instead of
  // silently flipping the cluster into an error state.
  return {
    commands: response.commands ?? [],
    reasoning: response.reasoning,
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

  // Bind this recognition run to the current canvas. If the user switches
  // canvases (or the canvas reloads) before we commit, we must abandon the
  // result rather than apply commands referencing strokes from the wrong
  // canvas.
  const startCanvasId = useCanvasStore.getState().canvasId;
  const isStillCurrent = () =>
    useCanvasStore.getState().canvasId === startCanvasId;

  // Drop only this batch's in-progress overlays, leaving any `done`
  // overlays from previous batches untouched (their Accept/Revert UI is
  // the only way to undo already-applied commands).
  const clearBatchInProgress = () => {
    set({
      processingClusters: get().processingClusters.filter(
        (c) => c.status === 'done',
      ),
    });
  };

  // Each batch owns its own AbortController. Concurrent batches do NOT
  // cancel each other; only an explicit `cancelAnnotationRecognition`
  // (e.g. tool teardown / canvas switch) aborts everything.
  const controller = new AbortController();
  _activeRecognitions.add(controller);
  const { signal } = controller;

  try {
    const { nodes, edges } = useCanvasStore.getState();

    // ── Stage 1: Cluster ──────────────────────────────────────────
    const strokes = collectStrokes(annotationIds, nodes);
    if (strokes.length === 0) {
      // Strokes were deleted before recognition fired — drop the leftover
      // 'preparing'/'pending' overlays so they don't linger forever.
      clearBatchInProgress();
      return;
    }

    const clusters = clusterAnnotations(strokes);
    // Set of cluster ids owned by THIS batch. All subsequent state updates
    // are scoped to these ids so unrelated `done` overlays are preserved.
    const batchIds = new Set(clusters.map((c) => clusterKey(c)));

    // ── Stage 2: Extract spatial context (IDs only) ───────────────
    const contextsByCluster: AnnotationContext[] = clusters.map((cluster) =>
      extractAnnotationContext(cluster, nodes, edges),
    );
    const ctxByClusterId = new Map(
      contextsByCluster.map((c) => [clusterKey(c.cluster), c]),
    );

    // Refresh the overlay clusters and flip them to 'pending' — the idle timer
    // has fired, so we are now actively preparing the request.
    const initialBatch: AnnotationProcessingCluster[] = clusters.map((c) => {
      const cid = clusterKey(c);
      const ctx = ctxByClusterId.get(cid);
      return {
        id: cid,
        strokeIds: c.strokeIds,
        status: 'pending',
        canvasId: startCanvasId ?? undefined,
        contextSummary: ctx ? buildContextSummary(ctx) : undefined,
      };
    });
    set({
      processingClusters: [
        ...get().processingClusters.filter((c) => !batchIds.has(c.id)),
        ...initialBatch,
      ],
    });

    // ── Stage 3: Resolve every cluster via the server-side LLM agent ──
    // The rule-based fast path was removed because its false-positive rate
    // was too high — the LLM (with on-demand `read` / `inspect_nodes` /
    // `inspect_edges` access) now makes every call. Per-cluster requests
    // are independent and fire in parallel under the shared AbortSignal.
    const resolvedIntents: Array<{
      clusterId: string;
      intent: ResolvedAnnotationIntent;
    }> = [];
    const errorByCluster = new Map<string, string>();

    if (contextsByCluster.length > 0 && !signal.aborted) {
      // Switch this batch's clusters to 'running' the moment we start firing
      // requests. Other batches' clusters are left alone.
      set({
        processingClusters: get().processingClusters.map((c) =>
          batchIds.has(c.id) ? { ...c, status: 'running' } : c,
        ),
      });

      const llmResults = await Promise.allSettled(
        contextsByCluster.map(async (ctx) => {
          const cid = clusterKey(ctx.cluster);
          if (signal.aborted)
            return { cid, value: null as ResolvedAnnotationIntent | null };
          const screenshot = await captureCanvasScreenshot({
            stripPrefix: true,
          });
          if (!screenshot || signal.aborted) return { cid, value: null };
          const result = await resolveByLLM(
            ctx,
            screenshot,
            signal,
            startCanvasId ?? undefined,
          );
          return { cid, value: result };
        }),
      );

      for (const r of llmResults) {
        if (r.status === 'fulfilled') {
          const { cid, value } = r.value;
          if (value) {
            resolvedIntents.push({ clusterId: cid, intent: value });
          } else if (!signal.aborted) {
            errorByCluster.set(cid, 'No intent recognised by LLM');
          }
        } else {
          const err = r.reason as Error | undefined;
          if (err?.name !== 'AbortError') {
            console.error('[Annotation Intent] LLM call failed:', err);
          }
          // We don't know which cluster failed (allSettled erased the index);
          // mark all still-unresolved clusters with the error.
          const unresolved = new Set(
            contextsByCluster.map((c) => clusterKey(c.cluster)),
          );
          for (const { clusterId } of resolvedIntents)
            unresolved.delete(clusterId);
          for (const cid of unresolved) {
            if (!errorByCluster.has(cid)) {
              errorByCluster.set(cid, err?.message ?? 'LLM call failed');
            }
          }
        }
      }
    }

    if (signal.aborted) {
      // Bulk cancel (tool teardown / canvas switch) hit us mid-flight —
      // leave overlay state to whoever caused the abort.
      return;
    }

    // Canvas changed under us during the LLM call — abandon results so we
    // don't apply commands referencing the wrong canvas.
    if (!isStillCurrent()) {
      clearBatchInProgress();
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
          resolvedIntents.map((r) => r.intent.reasoning).join(' | '),
        );
      }

      // Promote any clusters still in pending/preparing to 'running' for the
      // brief duration of executeCommands so the user sees the same
      // lifecycle. Scoped to this batch's ids only.
      set({
        processingClusters: get().processingClusters.map((c) =>
          batchIds.has(c.id) &&
          (c.status === 'pending' || c.status === 'preparing')
            ? { ...c, status: 'running' }
            : c,
        ),
      });

      // Final canvas check immediately before commit.
      if (!isStillCurrent()) {
        clearBatchInProgress();
        return;
      }

      useCanvasStore.getState().executeCommands(allCommands, 'agent');
    }

    // Index resolved intents by cluster so the final write can attach
    // source / reasoning / commands per overlay.
    const intentByCluster = new Map<string, ResolvedAnnotationIntent>();
    for (const { clusterId, intent } of resolvedIntents) {
      intentByCluster.set(clusterId, intent);
    }

    // Mark this batch's clusters 'done' and attach their captured changes
    // so the overlay can render accept/revert/blend buttons. Overlays linger
    // on the canvas until the user resolves them. Other batches' clusters
    // are not touched.
    set({
      processingClusters: get().processingClusters.map((c) => {
        if (!batchIds.has(c.id)) return c;
        const intent = intentByCluster.get(c.id);
        return {
          ...c,
          status: 'done',
          changes: changesByCluster.get(c.id) ?? c.changes,
          commands: intent?.commands ?? c.commands,
          reasoning: intent?.reasoning ?? c.reasoning,
          source: intent ? 'llm' : c.source,
          error: errorByCluster.get(c.id) ?? c.error,
        };
      }),
    });
  } finally {
    _activeRecognitions.delete(controller);
  }
}
