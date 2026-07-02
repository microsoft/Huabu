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
  type ExecuteConflict,
  type ExecuteOriginator,
} from '@sediment/shared';
import {
  applySharedPostEffectsFromWriteResult,
  applyDeltas,
  diffCanvasState,
  executeCanvasCommands,
  extractCanvasChanges,
  nodeRevision,
  type CanvasChangeRecord,
  type CanvasEdge,
  type CanvasNode,
  type Delta,
} from '@sediment/shared/canvas-engine';

import { publishCanvasUpdate } from './canvas-sync.js';
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
  'office',
  'image',
  'video',
  'audio',
  'frame',
  'question',
  'sketch',
]);

const TEXT_BEARING_NODE_TYPES = new Set([
  'note',
  'text',
  'web',
  'pdf',
  'office',
  'question',
]);

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

/**
 * Compare-and-swap pre-flight for agent content writes. For each
 * `MERGE_NODE_DATA` patch that rewrites authored content (`content` /
 * `src`), compare the writer's `expectRev` against the hydrated node's
 * current {@link nodeRevision}. A missing `expectRev` (the agent never
 * read the node this run) or a mismatch (edited since) is a conflict.
 * Patches touching only non-content fields (label / summary / style)
 * are not guarded — they fall outside the revision's key set.
 */
function collectMergeConflicts(
  commands: readonly CanvasCommand[],
  prestateNodes: readonly CanvasNode[],
): ExecuteConflict[] {
  const byId = new Map(prestateNodes.map((n) => [n.id, n]));
  const conflicts: ExecuteConflict[] = [];
  for (const cmd of commands) {
    if (cmd.type !== 'MERGE_NODE_DATA') continue;
    for (const entry of cmd.patches) {
      const patch = entry.patch ?? {};
      const rewritesContent = 'content' in patch || 'src' in patch;
      if (!rewritesContent) continue;
      const node = byId.get(entry.nodeId);
      if (!node) continue; // missing node → engine emits 'not-found'
      const currentRev = nodeRevision(node);
      const rawContent = (node.data as Record<string, unknown> | undefined)?.[
        'content'
      ];
      const currentContent =
        typeof rawContent === 'string' ? rawContent : undefined;
      if (entry.expectRev === undefined || entry.expectRev !== currentRev) {
        conflicts.push({
          nodeId: entry.nodeId,
          ...(entry.expectRev !== undefined
            ? { expectedRev: entry.expectRev }
            : {}),
          currentRev,
          ...(currentContent !== undefined ? { currentContent } : {}),
        });
      }
    }
  }
  return conflicts;
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
    content: extractSidecarBody(nodeType, data),
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

/**
 * Resolve the markdown body that should be written for `nodeType`.
 *
 * The three write paths — `canvas.route.ts` PUT, this AI executor, and
 * the web's `nodeContentQueue.buildRequest` — all derive the sidecar
 * body from `data.content`. Keeping that one rule shared (via
 * `TEXT_BEARING_NODE_TYPES`) is the whole reason question prompts now
 * live at `data.content` rather than the nested `data.input.content`
 * shape they once had.
 */
function extractSidecarBody(
  nodeType: string,
  data: Record<string, unknown>,
): string {
  if (!TEXT_BEARING_NODE_TYPES.has(nodeType)) return '';
  return typeof data['content'] === 'string' ? (data['content'] as string) : '';
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
  /**
   * When true, derive {@link CanvasChangeRecord}s from the batch deltas
   * (label + inverse deltas + staleness fingerprint) and return them in
   * `changes`. Off by default — only the out-of-band `/execute` route
   * (ACP agents) opts in so the built-in agent path pays no cost.
   */
  computeChanges?: boolean;
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
  /**
   * Per-change review records (label + inverse deltas + staleness
   * fingerprint). Only populated when `computeChanges` was requested.
   */
  changes?: CanvasChangeRecord[];
  /**
   * Compare-and-swap rejections. Non-empty only when an agent
   * `MERGE_NODE_DATA` content write targeted a stale (or never-read)
   * node; the whole batch is then a no-op (nothing applied) and the
   * caller reconciles from `currentContent` / `currentRev`.
   */
  conflicts?: ExecuteConflict[];
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

    // Compare-and-swap pre-flight (agent writes only). A stale or
    // never-read content rewrite mutates NOTHING — the whole batch is a
    // no-op and the agent reconciles from the echoed `currentContent`.
    // ui / system writes are trusted and skip the guard.
    if (originator.source === 'agent') {
      const conflicts = collectMergeConflicts(commands, prestateNodes);
      if (conflicts.length > 0) {
        const conflictIds = new Set(conflicts.map((c) => c.nodeId));
        return {
          canvasId,
          fromVersion,
          toVersion: fromVersion,
          deltas: [],
          results: commands.map((command) => ({
            command,
            applied: false,
            ...(command.type === 'MERGE_NODE_DATA' &&
            command.patches.some((p) => conflictIds.has(p.nodeId))
              ? { reason: 'conflict' as const }
              : {}),
          })),
          commands,
          pendingEffects: {
            mutatedNodes: [],
            deletedNodeIds: [],
            contentEditedNodeIds: [],
            deferredFitFrameIds: [],
          },
          conflicts,
        };
      }
    }

    const { writeResult, commandResults, pendingEffects } =
      executeCanvasCommands(
        { source: originator.source, commands },
        {
          nodes: prestateNodes,
          edges: prestateEdges,
          canvasId,
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
    //
    // `writeNode` throws `CanvasStoreIOError` on environmental failures
    // (ENOSPC, EACCES, …); we deliberately do NOT catch it so the
    // batch aborts before canvas.json is mutated. The exception bubbles
    // through `handleCanvasCommands` and surfaces as an `isError: true`
    // tool result to the LLM (and as a 500 / error event upstream).
    // Structural `conflict` / `not-found` results are programmer errors
    // in the agent path (engine should have rejected them upstream and
    // `strictRename` is rarely set for agent-authored labels); we throw
    // a regular Error rather than letting the in-memory mutation drift
    // away from disk.
    for (const node of pendingEffects.mutatedNodes) {
      const nodeContent = buildNodeContent(node);
      if (!nodeContent) continue;
      const result = store.writeNode(nodeContent.nodeId, nodeContent, {
        strictRename: nodeContent['labelSource'] === 'user',
      });
      if (!result.ok) {
        const detail =
          result.reason === 'conflict'
            ? `label conflicts with existing node "${result.conflictWith.filename}"`
            : result.reason;
        throw new Error(
          `[canvas-executor] writeNode rejected ${nodeContent.nodeId}: ${detail}`,
        );
      }
    }
    for (const nodeId of pendingEffects.deletedNodeIds) {
      store.deleteNode(nodeId);
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

    // Derive review records (ACP change cards) only when asked. Edge
    // endpoint labels are resolved against the post-state nodes.
    let changes: CanvasChangeRecord[] | undefined;
    if (input.computeChanges) {
      const labelById = new Map<string, string>();
      for (const node of finalNodes) {
        const lbl = (node.data as Record<string, unknown> | undefined)?.[
          'label'
        ];
        if (typeof lbl === 'string' && lbl) labelById.set(node.id, lbl);
      }
      changes = extractCanvasChanges(deltas, { nodeLabelById: labelById });
    }

    // Broadcast the delta to live frontends and persist review records to
    // the originating thread's sidecar. Every accepted write broadcasts —
    // the initiating tab applies it from the sync stream, not the tool
    // result. No-op fast path above already returned for empty diffs.
    //
    // When attributed to a thread, fold this batch's records into the
    // thread's coalesced change list (one net record per entity) and
    // broadcast that full list so live cards replace their state with it —
    // matching what GET /changes returns.
    let broadcastChanges = changes;
    if (originator.threadId && changes && changes.length > 0) {
      try {
        broadcastChanges = store.appendChanges(originator.threadId, changes);
      } catch {
        /* sidecar persistence is best-effort — never fail the write */
      }
    }
    publishCanvasUpdate(canvasId, {
      type: 'update',
      data: {
        fromVersion,
        toVersion,
        deltas,
        pendingEffects: {
          mutatedNodes: pendingEffects.mutatedNodes,
          deletedNodeIds: pendingEffects.deletedNodeIds,
          contentEditedNodeIds: pendingEffects.contentEditedNodeIds,
          deferredFitFrameIds: pendingEffects.deferredFitFrameIds,
        },
        ...(originator.threadId ? { threadId: originator.threadId } : {}),
        ...(broadcastChanges ? { changes: broadcastChanges } : {}),
      },
    });

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
      ...(changes ? { changes } : {}),
    };
  });
}

/**
 * Apply a list of {@link Delta}s directly against the canvas's
 * authoritative state — used to revert a change card's `revertDeltas`.
 *
 * Mirrors {@link executeOnServer}'s persistence (hydrate → apply →
 * persist `.md` + canvas.json → append delta-log → bump version) but
 * starts from deltas rather than commands, so revert needs no fragile
 * delta→command round-trip. Returns the structural deltas + pending
 * effects so the caller can broadcast them. No-op (empty diff) leaves
 * the version untouched.
 */
export async function applyDeltasOnServer(input: {
  canvasId: string;
  deltas: readonly Delta[];
  originator: ExecuteOriginator;
  runId?: string;
}): Promise<{
  canvasId: string;
  fromVersion: number;
  toVersion: number;
  deltas: Delta[];
  pendingEffects: {
    mutatedNodes: CanvasNode[];
    deletedNodeIds: string[];
    contentEditedNodeIds: string[];
    deferredFitFrameIds: string[];
  };
}> {
  const { canvasId, originator, runId } = input;

  return await withCanvasMutex(canvasId, async () => {
    const store = getCanvasStore(canvasId);
    const canvas = store.read();
    if (!canvas) throw new CanvasNotFoundError(canvasId);

    const fromVersion = canvas.version;
    const prestateNodes = hydrateNodes(
      store,
      canvas.state.nodes as CanvasNode[],
    );
    const prestateEdges = (canvas.state.edges ?? []) as CanvasEdge[];

    const final = applyDeltas(
      { nodes: prestateNodes, edges: prestateEdges },
      input.deltas,
    );
    const finalNodes = final.nodes;
    const finalEdges = final.edges;

    // Recompute the authoritative diff so the log row and broadcast
    // reflect exactly what landed (tolerates already-applied / missing
    // targets in the input deltas).
    const deltas = diffCanvasState(
      { nodes: prestateNodes, edges: prestateEdges },
      { nodes: finalNodes, edges: finalEdges },
    );

    const mutatedNodes: CanvasNode[] = [];
    const deletedNodeIds: string[] = [];
    const contentEditedNodeIds: string[] = [];

    if (deltas.length === 0) {
      return {
        canvasId,
        fromVersion,
        toVersion: fromVersion,
        deltas,
        pendingEffects: {
          mutatedNodes,
          deletedNodeIds,
          contentEditedNodeIds,
          deferredFitFrameIds: [],
        },
      };
    }

    const toVersion = fromVersion + 1;

    for (const d of deltas) {
      if (d.type === 'INSERT_NODE' || d.type === 'REPLACE_NODE') {
        const node = d.type === 'INSERT_NODE' ? d.node : d.next;
        mutatedNodes.push(node);
        if (d.type === 'REPLACE_NODE') contentEditedNodeIds.push(node.id);
        const content = buildNodeContent(node);
        if (content) {
          store.writeNode(content.nodeId, content, {
            strictRename: content['labelSource'] === 'user',
          });
        }
      } else if (d.type === 'DELETE_NODE') {
        deletedNodeIds.push(d.node.id);
        store.deleteNode(d.node.id);
      }
    }

    const slimNodes = stripNodesForCanvas(finalNodes);
    store.write({
      ...canvas,
      version: toVersion,
      state: { ...canvas.state, nodes: slimNodes, edges: finalEdges },
      updatedAt: Date.now(),
    });

    store.appendDeltaLogEntry({
      version: toVersion,
      ts: Date.now(),
      ...(runId ? { runId } : {}),
      commands: [],
      deltas: deltas as unknown[],
      originator,
    });

    return {
      canvasId,
      fromVersion,
      toVersion,
      deltas,
      pendingEffects: {
        mutatedNodes,
        deletedNodeIds,
        contentEditedNodeIds,
        deferredFitFrameIds: [],
      },
    };
  });
}
