/**
 * Headless canvas executor — server-side runner for `CanvasCommand` batches.
 *
 * Drives the shared engine (`@sediment/shared/canvas-engine`) against
 * authoritative `<canvasDir>/canvas.json` state, persists both the
 * canvas structure and the per-node markdown sidecars, computes the
 * structural deltas the engine produced, and appends one row per
 * mutating batch to `<canvasDir>/.history/delta-log.jsonl`.
 *
 * Wire entry point: `POST /api/canvas/:canvasId/execute` (M2).
 * Internal entry point: the agent's `canvas_commands` tool handler.
 *
 * Concurrency model: one in-flight batch per canvas, enforced by a
 * promise-chain mutex (see {@link withCanvasMutex}). The mutex pairs
 * with the canvas-level monotonic `version` counter so two parallel
 * callers never observe the same prestate.
 *
 * What this module does NOT do (Phase A scoping notes):
 *   - Trigger preprocessing. The web side already drives that via the
 *     dispatch endpoint based on `pendingEffects.mutatedNodes` in the
 *     response payload; pulling preprocessing fully server-side is
 *     part of M3 once cross-tab broadcast lands.
 *   - Broadcast deltas to other tabs. M3.
 *   - Per-command granular delta log rows. Phase A writes one row per
 *     /execute call. Per-command granularity arrives in M5 alongside
 *     fine-grained `SET_*` deltas.
 */

import {
  createId,
  type CanvasCommand,
  type CanvasCommandFailureReason,
  type CanvasEdgeId,
  type CanvasNodeId,
  type ExecuteOriginator,
} from '@sediment/shared';
import {
  applySharedPostEffectsFromWriteResult,
  diffCanvasState,
  executeCanvasCommands,
  type CanvasEdge,
  type CanvasNode,
  type Delta,
} from '@sediment/shared/canvas-engine';

import {
  getCanvasStore,
  type CanvasFile,
  type CanvasStore,
  type DeltaLogEntry,
  type NodeContent,
} from '../storage/index.js';

// ── Per-canvas async mutex ───────────────────────────────────────────────
//
// A single promise per canvasId records the tail of the in-flight task
// chain. New callers attach onto that tail; the chain catches errors so
// one failed batch does not poison subsequent ones. We clean up the map
// entry only when our own chain is still the head — otherwise newer
// schedules already extended it and own the cleanup.

const canvasMutexChains = new Map<string, Promise<unknown>>();

async function withCanvasMutex<T>(
  canvasId: string,
  task: () => Promise<T>,
): Promise<T> {
  const prev = canvasMutexChains.get(canvasId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(task);
  canvasMutexChains.set(canvasId, next);
  try {
    return await next;
  } finally {
    if (canvasMutexChains.get(canvasId) === next) {
      canvasMutexChains.delete(canvasId);
    }
  }
}

// ── Markdown-backed-node knowledge (mirrors canvas.route.ts) ─────────────
//
// Kept in sync with the equivalent sets in `canvas.route.ts`. Both files
// are intentionally self-contained so an accidental import cycle
// between the route and the executor cannot occur — when these sets
// drift we have a single failing test (per-node content round-trip) that
// surfaces the discrepancy. See `docs/node-content-api-split.md`.

const MD_BACKED_NODE_TYPES = new Set([
  'note',
  'text',
  'web',
  'pdf',
  'image',
  'video',
  'audio',
  'frame',
  'question',
]);

const TEXT_BEARING_NODE_TYPES = new Set(['note', 'text', 'web', 'pdf']);

const NODE_CONTENT_KEYS = new Set([
  'content',
  'label',
  'labelSource',
  'src',
  'summary',
  'keywords',
  'provenance',
]);

function stripNodesForCanvas(nodes: readonly CanvasNode[]): CanvasNode[] {
  return nodes.map((node) => {
    const data = (node.data ?? {}) as Record<string, unknown>;
    const cleanData: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (NODE_CONTENT_KEYS.has(k)) continue;
      cleanData[k] = v;
    }
    return { ...node, data: cleanData };
  });
}

function hydrateNodes(
  store: CanvasStore,
  nodes: readonly CanvasNode[],
): CanvasNode[] {
  return nodes.map((node) => {
    const nodeId = typeof node.id === 'string' ? node.id : '';
    if (!nodeId) return { ...node };
    const nodeType = typeof node.type === 'string' ? node.type : '';
    if (!MD_BACKED_NODE_TYPES.has(nodeType)) return { ...node };

    let content: NodeContent | null = null;
    try {
      content = store.readNode(nodeId);
    } catch {
      content = null;
    }
    if (!content) return { ...node };

    const data: Record<string, unknown> = { ...(node.data ?? {}) };
    if (TEXT_BEARING_NODE_TYPES.has(nodeType)) {
      data['content'] = content.content;
    }
    if (typeof content.src === 'string' && content.src.length > 0) {
      data['src'] = content.src;
    }
    if (content.label != null && data['label'] == null) {
      data['label'] = content.label;
    }
    if (content['summary'] != null) data['summary'] = content['summary'];
    if (content['keywords'] != null) data['keywords'] = content['keywords'];
    if (content['provenance'] != null)
      data['provenance'] = content['provenance'];
    if (content['labelSource'] != null) {
      data['labelSource'] = content['labelSource'];
    }
    return { ...node, data };
  });
}

function buildNodeContent(node: CanvasNode): NodeContent | null {
  const nodeId = typeof node.id === 'string' ? node.id : '';
  if (!nodeId) return null;
  const nodeType = typeof node.type === 'string' ? node.type : '';
  if (!MD_BACKED_NODE_TYPES.has(nodeType)) return null;

  const data = (node.data ?? {}) as Record<string, unknown>;
  const out: NodeContent = {
    nodeId,
    type: nodeType,
    label: typeof data['label'] === 'string' ? (data['label'] as string) : null,
    content:
      TEXT_BEARING_NODE_TYPES.has(nodeType) &&
      typeof data['content'] === 'string'
        ? (data['content'] as string)
        : '',
  };
  if (typeof data['src'] === 'string') out['src'] = data['src'] as string;
  if (typeof data['summary'] === 'string') out['summary'] = data['summary'];
  if (Array.isArray(data['keywords'])) out['keywords'] = data['keywords'];
  if ('provenance' in data) out['provenance'] = data['provenance'];
  const labelSource = data['labelSource'];
  if (
    labelSource === 'user' ||
    labelSource === 'auto' ||
    labelSource === 'agent'
  ) {
    out['labelSource'] = labelSource;
  }
  return out;
}

// ── ID pre-assignment ────────────────────────────────────────────────────
//
// LLM-issued `CREATE_NODES` / `CONNECT_NODES` commands frequently omit
// ids (the prompt encourages this so the model does not have to invent
// stable identifiers). We assign them before the engine sees the batch
// so every downstream consumer — including the delta-log — references
// the same ids the engine will operate on.

function preAssignIds(commands: readonly CanvasCommand[]): CanvasCommand[] {
  const out: CanvasCommand[] = [];
  for (const cmd of commands) {
    if (cmd.type === 'CREATE_NODES') {
      const nodes = cmd.nodes.map((n) => {
        if (n.id) return n;
        return { ...n, id: createId('node') as CanvasNodeId };
      });
      out.push({ ...cmd, nodes });
      continue;
    }
    if (cmd.type === 'CONNECT_NODES') {
      const edges = cmd.edges.map((e) => {
        if (e.id) return e;
        return { ...e, id: createId('edge') as CanvasEdgeId };
      });
      out.push({ ...cmd, edges });
      continue;
    }
    out.push(cmd);
  }
  return out;
}

// ── Public entry ─────────────────────────────────────────────────────────

export interface ExecuteOnServerInput {
  canvasId: string;
  commands: readonly CanvasCommand[];
  originator: ExecuteOriginator;
  runId?: string;
}

export interface ExecuteOnServerOutput {
  canvasId: string;
  fromVersion: number;
  toVersion: number;
  deltas: Delta[];
  results: Array<{
    command: CanvasCommand;
    applied: boolean;
    reason?: CanvasCommandFailureReason;
  }>;
  /** Commands as the executor saw them — ids assigned, source-stamped. */
  commands: CanvasCommand[];
  /**
   * Subset of `PendingEffects` that clients need to drain locally.
   *
   * `mutatedNodes` is included so the web's existing `triggerPreprocessing`
   * pipeline can still run (Phase A keeps preprocessing on the web; M3
   * will move it server-side once cross-tab broadcast lands).
   */
  pendingEffects: {
    mutatedNodes: CanvasNode[];
    deletedNodeIds: string[];
    contentEditedNodeIds: string[];
    deferredFitFrameIds: string[];
  };
}

export class CanvasNotFoundError extends Error {
  readonly canvasId: string;
  constructor(canvasId: string) {
    super(`Canvas not found: ${canvasId}`);
    this.name = 'CanvasNotFoundError';
    this.canvasId = canvasId;
  }
}

/**
 * Execute a batch of canvas commands against `canvasId`'s authoritative
 * state. Atomic per-canvas (mutex-guarded). On success the canvas
 * `version` is bumped by one and a single row is appended to the
 * delta log.
 *
 * No-op batches (every command rejected or the diff is empty) leave the
 * version untouched and skip the log append — concurrent UI clients
 * see no change and never get spurious 409s from idempotent calls.
 */
export async function executeOnServer(
  input: ExecuteOnServerInput,
): Promise<ExecuteOnServerOutput> {
  const { canvasId, originator, runId } = input;
  const commands = preAssignIds(input.commands);

  return await withCanvasMutex(canvasId, async () => {
    const store = getCanvasStore(canvasId);
    const canvas = store.read();
    if (!canvas) throw new CanvasNotFoundError(canvasId);

    const fromVersion = canvas.version;

    // Hydrate per-node content from .md sidecars before the engine sees
    // the prestate — handlers like MERGE_NODE_DATA need the current
    // `data.content` to merge against, but canvas.json never carries it.
    const prestateNodes = hydrateNodes(
      store,
      canvas.state.nodes as CanvasNode[],
    );
    const prestateEdges = (canvas.state.edges ?? []) as CanvasEdge[];

    const { writeResult, commandResults, pendingEffects } =
      executeCanvasCommands(
        { source: originator.source, commands },
        {
          nodes: prestateNodes,
          edges: prestateEdges,
          canvasId,
          autoLayoutEnabled: true,
        },
        { forceFitFrames: originator.source === 'agent' },
      );

    // Pure host-agnostic cleanups (edge handle reroute) — same path the
    // web's `executeCommands` runs before its set().
    const sharedOut = applySharedPostEffectsFromWriteResult(writeResult);
    const finalNodes = writeResult.nodes;
    const finalEdges = sharedOut.edges;

    const deltas = diffCanvasState(
      { nodes: prestateNodes, edges: prestateEdges },
      { nodes: finalNodes, edges: finalEdges },
    );

    const results = commandResults.map((r) => ({
      command: r.command,
      applied: r.applied,
      ...(r.reason ? { reason: r.reason } : {}),
    }));

    // Detect order-only mutations that `diffCanvasState` cannot see.
    //
    // `diffCanvasState` is id-keyed: it returns INSERT/DELETE/REPLACE rows
    // by comparing id sets and per-id reference identity. Commands whose
    // only effect is to reshuffle the nodes/edges array (today only
    // `REORDER_NODES`, which rebuilds the array with the same refs in a
    // new order) therefore emit zero structural deltas. Without this
    // guard the no-op fast path below would skip persistence entirely,
    // leaving the agent with `applied: true` while canvas.json on disk
    // is unchanged.
    //
    // We do NOT synthesise a delta — Phase A has no order-aware delta
    // type, and cross-tab broadcast (M3) is not shipped yet. We just
    // fall through to the persistence branch so canvas.json and the
    // delta-log version both reflect that something happened. Catch-up
    // clients on M3 will see the version bump and need to refetch the
    // full canvas; that's an acceptable Phase-A trade-off.
    const orderChanged =
      prestateNodes.length !== finalNodes.length ||
      prestateEdges.length !== finalEdges.length ||
      prestateNodes.some((n, i) => n.id !== finalNodes[i]?.id) ||
      prestateEdges.some((e, i) => e.id !== finalEdges[i]?.id);

    // No-op fast path. Returning early preserves the invariant that
    // `toVersion === fromVersion` IFF no row was appended to the log.
    if (deltas.length === 0 && !orderChanged) {
      return {
        canvasId,
        fromVersion,
        toVersion: fromVersion,
        deltas,
        results,
        commands,
        pendingEffects: {
          mutatedNodes: pendingEffects.mutatedNodes,
          deletedNodeIds: pendingEffects.deletedNodeIds,
          contentEditedNodeIds: pendingEffects.contentEditedNodeIds,
          deferredFitFrameIds: pendingEffects.deferredFitFrameIds,
        },
      };
    }

    const toVersion = fromVersion + 1;

    // Persist .md sidecars FIRST so the canvas.json never references a
    // markdown file that does not exist on disk. A crash between this
    // loop and the canvas.json write leaves orphan .md files (harmless),
    // not orphan node references (would render as `contentMissing`).
    for (const node of pendingEffects.mutatedNodes) {
      const nodeContent = buildNodeContent(node);
      if (!nodeContent) continue;
      try {
        store.writeNode(nodeContent.nodeId, nodeContent, {
          strictRename: nodeContent['labelSource'] === 'user',
        });
      } catch (err) {
        // Best-effort: a sidecar write failure for one node should not
        // abort the whole batch — the canvas.json write below still
        // captures the structural change.

        console.warn(
          `[canvas-executor] writeNode failed for ${nodeContent.nodeId}:`,
          err,
        );
      }
    }
    for (const nodeId of pendingEffects.deletedNodeIds) {
      try {
        store.deleteNode(nodeId);
      } catch (err) {
        console.warn(`[canvas-executor] deleteNode failed for ${nodeId}:`, err);
      }
    }

    const slimNodes = stripNodesForCanvas(finalNodes);
    const nextCanvas: CanvasFile = {
      ...canvas,
      version: toVersion,
      state: {
        ...canvas.state,
        nodes: slimNodes,
        edges: finalEdges,
      },
      updatedAt: Date.now(),
    };
    store.write(nextCanvas);

    const logEntry: DeltaLogEntry = {
      version: toVersion,
      ts: Date.now(),
      ...(runId ? { runId } : {}),
      commands: commands as unknown[],
      deltas: deltas as unknown[],
      originator,
    };
    store.appendDeltaLogEntry(logEntry);

    return {
      canvasId,
      fromVersion,
      toVersion,
      deltas,
      results,
      commands,
      pendingEffects: {
        mutatedNodes: pendingEffects.mutatedNodes,
        deletedNodeIds: pendingEffects.deletedNodeIds,
        contentEditedNodeIds: pendingEffects.contentEditedNodeIds,
        deferredFitFrameIds: pendingEffects.deferredFitFrameIds,
      },
    };
  });
}
