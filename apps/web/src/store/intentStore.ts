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
import { clusterSketches, extractSketchContext } from '@/handler/sketch';
import { snapshotAndExtractChanges } from '@/hooks/useCanvasChanges';

import useCanvasStore from './canvasStore';
import {
  recognizeIntentStream,
  recognizeSketchCommands,
  logIntentEpisode,
} from '../api/intent';

import type { CanvasChange } from '@/hooks/useCanvasChanges';
import type {
  SketchNodeRef,
  SketchContext,
  SketchCluster,
  ResolvedSketchIntent,
  CanvasCommand,
  CanvasNodeId,
  IntentCandidate,
  SketchClusterContext,
} from '@sediment/shared';
import type { Node } from '@xyflow/react';

/**
 * Lifecycle status for a sketch cluster currently being recognised.
 *
 * - `preparing` — user is still drawing; idle timer not yet fired.
 * - `pending`   — idle timer fired; running rule resolution + screenshot capture.
 * - `running`   — LLM request is in flight (or commands are being applied).
 * - `done`      — finished; overlay stays visible until the next batch.
 */
export type SketchProcessingStatus =
  | 'preparing'
  | 'pending'
  | 'running'
  | 'done';

/** A single sketch cluster currently visible in the processing overlay. */
export interface SketchProcessingCluster {
  /** Stable id derived from the cluster's sketch node ids. */
  id: string;
  /** Sketch node ids contained in this cluster. */
  strokeIds: string[];
  status: SketchProcessingStatus;
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

  // ── Sketch recognition ──
  /** Clusters currently being processed; drives the on-canvas overlay. */
  processingClusters: SketchProcessingCluster[];
  /**
   * Explicit user-triggered recognition: the user selected one or more
   * sketch nodes and clicked the toolbar's `Apply Sketch` button.
   * Sketch IDs are clustered, contextualised and sent to the server-side
   * vision LLM. There is no idle timer — nothing fires automatically.
   */
  requestSketchRecognition: (sketchIds: string[]) => void;
  /** Cancel any in-flight sketch recognition (e.g. canvas switch). */
  cancelSketchRecognition: () => void;
  /**
   * Keep the cluster's intent commands and remove both the overlay and the
   * sketch strokes from the canvas.
   */
  acceptCluster: (clusterId: string) => void;
  /**
   * Revert the cluster's intent commands to restore the canvas state, then
   * remove both the overlay and the sketch strokes from the canvas.
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

export const useIntentStore = create<IntentState>()((set, get) => ({
  isOpen: false,
  isLoading: false,
  isStreaming: false,
  candidates: [],
  selectedIndex: -1,
  customIntent: '',
  position: null,
  contextSummary: '',
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

  // ── Sketch recognition ────────────────────────────────────────────

  requestSketchRecognition: (sketchIds: string[]) => {
    if (sketchIds.length === 0) return;
    void triggerSketchRecognition(get, set, sketchIds);
  },

  cancelSketchRecognition: () => {
    // Abort every currently in-flight batch and drop the registry.
    for (const ctrl of _activeRecognitions) ctrl.abort();
    _activeRecognitions.clear();
    set({ processingClusters: [] });
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

    // Always also delete the sketch strokes themselves on revert.
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
// Sketch recognition — three-stage pipeline
//
// Triggered explicitly by the user via the toolbar's `Apply Sketch` button
// (no idle timer). The store entry point is `requestSketchRecognition(ids)`.
//
// Stage 1: Cluster sketch strokes spatially
// Stage 2: Collect IDs of nearby/enclosed nodes + edges (no labels/positions)
// Stage 3: Send screenshot + IDs to the server-side LLM agent which fetches
//          additional node content on demand via `read` (markdown body),
//          node layout via `inspect_nodes` (canvas.json fields), and
//          edge style via `inspect_edges`.
//
// Each call to `triggerSketchRecognition` owns its own AbortController
// and runs independently of any other in-flight batches. Two consecutive
// batches can therefore execute in parallel — the second one does NOT cancel
// the first. Bulk cancellation (e.g. canvas switch) goes through
// `cancelSketchRecognition`, which aborts every currently-registered
// controller.
// ---------------------------------------------------------------------------

/** Registry of in-flight recognition batches, one entry per active call. */
const _activeRecognitions: Set<AbortController> = new Set();

/** Stable id for a cluster derived from its sketch node ids. */
function clusterKey(cluster: SketchCluster): string {
  return cluster.strokeIds.slice().sort().join('|');
}

/**
 * Build a short human-readable summary of the spatial context used by the
 * resolver. Used by the cluster inspector to explain "what the AI saw".
 */
function buildContextSummary(ctx: SketchContext): string {
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
 * Build {@link SketchNodeRef} descriptors from sketch node IDs.
 *
 * Positions are converted to absolute flow coordinates by walking up the
 * parent chain, so sketches drawn on top of frames / parented nodes still
 * report a correctly-placed bounding box. Per-stroke records inside each
 * node (`data.strokes`) are flattened into a single `points` array — the
 * AI side only needs aggregate geometry, so stroke boundaries are
 * intentionally collapsed here.
 */
function collectStrokes(sketchIds: string[], nodes: Node[]): SketchNodeRef[] {
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

  const strokes: SketchNodeRef[] = [];
  for (const id of sketchIds) {
    const node = byId.get(id);
    if (!node || node.type !== 'sketch') continue;

    const data = node.data as Record<string, unknown>;
    // Flatten every stroke's points into one array \u2014 the AI side only
    // needs node-level bounding boxes, so individual stroke boundaries
    // are intentionally collapsed.
    const nodeStrokes =
      (data.strokes as Array<{ points: number[][] }> | undefined) ?? [];
    const points: number[][] = nodeStrokes.flatMap((s) => s.points ?? []);
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
 * Convert a SketchContext to the wire payload sent to the server.
 * Carries id+type+label refs for nodes (so the LLM doesn't need a `read`
 * round-trip just to know what each id refers to) and bare ids for
 * edges. The LLM still fetches body text via `read`, layout via
 * `inspect_nodes`, and edge style via `inspect_edges` on demand.
 */
function toClusterContextPayload(ctx: SketchContext): SketchClusterContext {
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
 * Send the cluster + screenshot to the server-side sketch agent and
 * return the executable command batch it produced.
 */
async function resolveByLLM(
  ctx: SketchContext,
  screenshot: string,
  signal: AbortSignal,
  canvasId?: string,
): Promise<ResolvedSketchIntent | null> {
  const response = await recognizeSketchCommands(
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

async function triggerSketchRecognition(
  get: () => IntentState,
  set: (partial: Partial<IntentState>) => void,
  explicitIds: string[],
): Promise<void> {
  if (explicitIds.length === 0) return;

  // Dedupe and snapshot the batch.
  const sketchIds = Array.from(new Set(explicitIds));

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
  // cancel each other; only an explicit `cancelSketchRecognition`
  // (e.g. tool teardown / canvas switch) aborts everything.
  const controller = new AbortController();
  _activeRecognitions.add(controller);
  const { signal } = controller;

  try {
    const { nodes, edges } = useCanvasStore.getState();

    // ── Stage 1: Cluster ──────────────────────────────────────────
    const strokes = collectStrokes(sketchIds, nodes);
    if (strokes.length === 0) {
      // Strokes were deleted before recognition fired — drop the leftover
      // 'preparing'/'pending' overlays so they don't linger forever.
      clearBatchInProgress();
      return;
    }

    const clusters = clusterSketches(strokes);
    // Set of cluster ids owned by THIS batch. All subsequent state updates
    // are scoped to these ids so unrelated `done` overlays are preserved.
    const batchIds = new Set(clusters.map((c) => clusterKey(c)));

    // ── Stage 2: Extract spatial context (IDs only) ───────────────
    const contextsByCluster: SketchContext[] = clusters.map((cluster) =>
      extractSketchContext(cluster, nodes, edges),
    );
    const ctxByClusterId = new Map(
      contextsByCluster.map((c) => [clusterKey(c.cluster), c]),
    );

    // Refresh the overlay clusters and flip them to 'pending' — recognition
    // is preparing the request (capturing screenshot, etc.). The legacy
    // 'preparing' status set by the (now-removed) idle timer is no longer
    // produced; clusters jump straight from creation to 'pending'.
    const initialBatch: SketchProcessingCluster[] = clusters.map((c) => {
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
      intent: ResolvedSketchIntent;
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
            return { cid, value: null as ResolvedSketchIntent | null };
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
            console.error('[Sketch Intent] LLM call failed:', err);
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

    // Capture per-cluster CanvasChanges BEFORE executing anything, so each
    // entry's revert data reflects the canvas state that existed prior to
    // the intent batch.
    const changesByCluster = new Map<string, CanvasChange[]>();
    for (const { clusterId: cid, intent } of resolvedIntents) {
      if (intent.commands.length === 0) continue;
      const captured = snapshotAndExtractChanges(intent.commands);
      const existing = changesByCluster.get(cid) ?? [];
      changesByCluster.set(cid, [...existing, ...captured]);
    }

    // Aggregate all resolved commands and execute atomically as one batch.
    // Sketch nodes are kept on the canvas as ordinary nodes after
    // recognition \u2014 the user may invoke recognition repeatedly on the
    // same node (e.g. after editing nearby context). The Accept / Revert
    // buttons in `SketchProcessingOverlay` still let the user delete the
    // strokes when the resolution is committed.
    const allCommands: CanvasCommand[] = resolvedIntents.flatMap(
      (r) => r.intent.commands,
    );

    if (allCommands.length > 0) {
      if (resolvedIntents.length > 0) {
        console.log(
          '[Sketch Intent] Executing',
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
    const intentByCluster = new Map<string, ResolvedSketchIntent>();
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
