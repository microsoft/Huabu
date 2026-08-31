// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Headless canvas executor — server-side runner for `CanvasCommand` batches.
 *
 * Drives the shared engine (`@huabu/shared/canvas-engine`) against
 * authoritative structural state, persists both the
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

import { imageSize } from 'image-size';

import {
  createId,
  interactiveViewDefinitionV1Schema,
  interactiveViewRevision,
  type CanvasCommand,
  type CanvasCommandFailureReason,
  type CanvasEdgeId,
  type CanvasNodeId,
  type ExecuteConflict,
  type ExecuteOriginator,
  type InteractiveViewJsonValue,
} from '@huabu/shared';
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
} from '@huabu/shared/canvas-engine';

import { publishCanvasUpdate } from './canvas-sync.js';
import { importForeignNodeSources } from './import-node-src.js';
import {
  assertWorldPortalMutationsAllowed,
  assertWorldPortalResultAllowed,
} from './world-portal-policy.js';
import { getLogger } from '../../utils/logger.js';
import {
  space,
  withCanvasMutex,
  type BlobScope,
  type CanvasFile,
  type DeltaLogEntry,
  type NodeContent,
  type NodeSnapshot,
  type SpaceNodeMutation,
} from '../storage/index.js';

const log = getLogger('canvas.executor');

function insertedNodeIds(deltas: readonly Delta[]): Set<string> {
  return new Set(
    deltas.flatMap((delta) =>
      delta.type === 'INSERT_NODE' ? [delta.node.id] : [],
    ),
  );
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
  records: ReadonlyMap<string, NodeSnapshot>,
  nodes: readonly CanvasNode[],
): CanvasNode[] {
  return nodes.map((node) => {
    const nodeId = typeof node.id === 'string' ? node.id : '';
    if (!nodeId) return { ...node };
    const nodeType = typeof node.type === 'string' ? node.type : '';
    if (!MD_BACKED_NODE_TYPES.has(nodeType)) return { ...node };

    const content = records.get(nodeId)?.record ?? null;
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
 * `MERGE_NODE_DATA` patch that rewrites the authored body (`content`),
 * compare the writer's `expectRev` against the hydrated node's current
 * {@link nodeRevision}. A missing `expectRev` (the agent never read the
 * node this run) or a mismatch (edited since) is a conflict.
 *
 * Only `content` is guarded — NOT `src`. `src` is a short pointer (an
 * external URL / `artifacts/<file>` handle), not a mergeable body, and a
 * media node's `src` is never reached via a `nodes/<label>.md` read (the
 * agent reads the artifact the `src` points at, not the sidecar), so the
 * read-set never holds its rev — guarding it would reject every legit
 * `src` rewrite as `not-read`. Patches touching only non-body fields
 * (`src` / label / summary / style) are unconditional, like ui writes.
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
      const rewritesContent = 'content' in patch;
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
          reason: entry.expectRev === undefined ? 'not-read' : 'stale',
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

export interface InteractiveViewConflict {
  nodeId: string;
  expectedRevision: string;
  currentRevision: string;
  currentState: InteractiveViewJsonValue;
}

function collectInteractiveViewConflicts(
  commands: readonly CanvasCommand[],
  prestateNodes: readonly CanvasNode[],
): InteractiveViewConflict[] {
  const byId = new Map(prestateNodes.map((node) => [node.id, node]));
  const conflicts: InteractiveViewConflict[] = [];
  for (const command of commands) {
    if (command.type !== 'MERGE_NODE_DATA') continue;
    for (const entry of command.patches) {
      if (
        entry.expectViewRev === undefined ||
        !Object.prototype.hasOwnProperty.call(entry.patch, 'interactiveView')
      ) {
        continue;
      }
      const node = byId.get(entry.nodeId);
      const parsed = interactiveViewDefinitionV1Schema.safeParse(
        node?.data?.interactiveView,
      );
      if (!node || node.type !== 'web' || !parsed.success) continue;
      const currentRevision = interactiveViewRevision(parsed.data);
      if (entry.expectViewRev !== currentRevision) {
        conflicts.push({
          nodeId: entry.nodeId,
          expectedRevision: entry.expectViewRev,
          currentRevision,
          currentState: parsed.data.state.value,
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

// ── Image node size normalization ────────────────────────────────────────
//
// Image nodes should render at their source image's real aspect ratio. Agents
// provide only a target `width`; the server reads the artifact and derives the
// matching `height`. Two entry points share one helper:
//   - CREATE_NODES: fill in the create-input `size.height` before the engine runs.
//   - MERGE_NODE_DATA(src): append a SET_NODE_GEOMETRY so an in-place `src` swap
//     re-fits height to the new image.

/** Read a `src` string off a node's `data` bag, or null when absent/empty. */
function imageDataSrc(data: unknown): string | null {
  const src = (data as Record<string, unknown> | undefined)?.['src'];
  return typeof src === 'string' && src ? src : null;
}

/**
 * Read the image artifact at `src` and return the height that preserves its
 * aspect ratio at `width`. Returns null when the file is missing, unreadable,
 * or not a recognized image — callers then keep whatever size they had. Never
 * throws.
 */
async function aspectHeightForWidth(
  canvasId: string,
  src: string,
  width: number,
): Promise<number | null> {
  try {
    const dim = await readImageDimensions(space(canvasId).blobs, src);
    if (!dim?.width || !dim?.height || dim.width <= 0 || dim.height <= 0) {
      return null;
    }
    return Math.round(width * (dim.height / dim.width));
  } catch (error) {
    log.warn({ canvasId, src, error }, 'Failed to read image aspect ratio');
    return null;
  }
}

/**
 * Read just enough of an image blob to extract its intrinsic dimensions.
 *
 * `imageSize` only needs the format header (a few KB for PNG/GIF/WEBP/BMP; a
 * little more for some JPEGs), so we read a 64 KB head range instead of the
 * whole blob — a multi-MB artifact would otherwise be read fully into memory
 * here, and this runs inside the executor's per-canvas write lock. Only when the
 * head chunk is too small to carry the dimension marker (e.g. a JPEG with a
 * large EXIF thumbnail before its SOF) do we fall back to reading the entire
 * blob. Returns null when the blob is absent; can throw when the bytes are not
 * a recognized image — the caller treats both as null.
 */
async function readImageDimensions(
  blobs: BlobScope,
  name: string,
): Promise<{ width?: number; height?: number } | null> {
  const HEAD_BYTES = 64 * 1024;
  const opened = await blobs.open(name, { start: 0, end: HEAD_BYTES - 1 });
  if (!opened) return null;

  const chunks: Buffer[] = [];
  for await (const chunk of opened.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  try {
    const dim = imageSize(Buffer.concat(chunks));
    if (dim?.width && dim?.height) return dim;
  } catch {
    // Head chunk too small / dimension marker not reached yet — fall through
    // to the (rare) full-blob read below.
  }

  const full = await blobs.read(name);
  return full ? imageSize(full) : null;
}

/**
 * CREATE_NODES: for image nodes given a `width` but no `height`, fill in the
 * height from the source image's real aspect ratio.
 */
async function normalizeImageNodeSizes(
  canvasId: string,
  commands: readonly CanvasCommand[],
): Promise<CanvasCommand[]> {
  const out: CanvasCommand[] = [];
  for (const cmd of commands) {
    if (cmd.type !== 'CREATE_NODES') {
      out.push(cmd);
      continue;
    }
    const nodes = await Promise.all(
      cmd.nodes.map(async (node) => {
        if (
          node.nodeType !== 'image' ||
          !node.size ||
          typeof node.size.height === 'number'
        ) {
          return node;
        }
        const src = imageDataSrc(node.data);
        if (!src) return node;
        const height = await aspectHeightForWidth(
          canvasId,
          src,
          node.size.width,
        );
        if (height === null) return node;
        return { ...node, size: { width: node.size.width, height } };
      }),
    );
    out.push({ ...cmd, nodes });
  }
  return out;
}

/**
 * MERGE_NODE_DATA(src): when an agent points an existing image node at a new
 * artifact its aspect ratio changes. Append a SET_NODE_GEOMETRY (keeping the
 * node's current width) so height tracks the new image. Skipped when the same
 * batch already sets that node's geometry explicitly.
 */
async function normalizeMergeImageGeometry(
  canvasId: string,
  commands: readonly CanvasCommand[],
  prestateNodes: readonly CanvasNode[],
): Promise<CanvasCommand[]> {
  const nodeById = new Map<string, CanvasNode>();
  for (const node of prestateNodes) {
    if (typeof node.id === 'string') nodeById.set(node.id, node);
  }
  const explicitGeometry = new Set<string>();
  for (const cmd of commands) {
    if (cmd.type === 'SET_NODE_GEOMETRY') {
      for (const item of cmd.items) explicitGeometry.add(item.nodeId);
    }
  }

  const out: CanvasCommand[] = [];
  for (const cmd of commands) {
    out.push(cmd);
    if (cmd.type !== 'MERGE_NODE_DATA') continue;

    const items: Extract<
      CanvasCommand,
      { type: 'SET_NODE_GEOMETRY' }
    >['items'] = [];
    for (const entry of cmd.patches) {
      if (explicitGeometry.has(entry.nodeId)) continue;
      const src = entry.patch?.['src'];
      if (typeof src !== 'string' || !src) continue;
      const node = nodeById.get(entry.nodeId);
      if (node?.type !== 'image') continue;
      const width = (node.style as Record<string, unknown> | undefined)?.[
        'width'
      ];
      if (typeof width !== 'number' || width <= 0) continue;
      const height = await aspectHeightForWidth(canvasId, src, width);
      if (height === null) continue;
      items.push({ nodeId: entry.nodeId, size: { width, height } });
    }
    if (items.length > 0) out.push({ type: 'SET_NODE_GEOMETRY', items });
  }
  return out;
}

/**
 * SET_NODE_GEOMETRY: agents can pin an image node to an arbitrary width/height,
 * which would letterbox the image (it renders `object-contain`, so it never
 * distorts — it just gains whitespace bars). For any geometry item that sets a
 * `width` on an image node, recompute `height` from the source image's real
 * aspect ratio so the node box always hugs the image. Also fixes width-only
 * items, which would otherwise clear the pinned height and collapse the node.
 *
 * `src` is resolved by a forward walk so an in-batch create/`src`-swap that
 * precedes the resize uses the correct image. Nodes handled by
 * {@link normalizeMergeImageGeometry} are disjoint (that pass only appends
 * geometry for nodes WITHOUT an explicit item), so the two never double-read.
 */
async function normalizeSetGeometryImageSizes(
  canvasId: string,
  commands: readonly CanvasCommand[],
  prestateNodes: readonly CanvasNode[],
): Promise<CanvasCommand[]> {
  // nodeId → current image `src`; only image nodes are tracked.
  const imageSrcById = new Map<string, string>();
  for (const node of prestateNodes) {
    if (node.type !== 'image' || typeof node.id !== 'string') continue;
    const src = imageDataSrc(node.data);
    if (src) imageSrcById.set(node.id, src);
  }

  const out: CanvasCommand[] = [];
  for (const cmd of commands) {
    // Update the src map from creates / src-swaps BEFORE handling a resize,
    // so a create-then-resize (or merge-then-resize) in this batch resolves.
    if (cmd.type === 'CREATE_NODES') {
      for (const node of cmd.nodes) {
        if (node.nodeType !== 'image' || !node.id) continue;
        const src = imageDataSrc(node.data);
        if (src) imageSrcById.set(node.id, src);
      }
    } else if (cmd.type === 'MERGE_NODE_DATA') {
      for (const patch of cmd.patches) {
        if (!imageSrcById.has(patch.nodeId)) continue;
        const src = patch.patch?.['src'];
        if (typeof src === 'string' && src) imageSrcById.set(patch.nodeId, src);
      }
    }

    if (cmd.type !== 'SET_NODE_GEOMETRY') {
      out.push(cmd);
      continue;
    }

    const items = await Promise.all(
      cmd.items.map(async (item) => {
        if (!item.size || typeof item.size.width !== 'number') return item;
        const src = imageSrcById.get(item.nodeId);
        if (!src) return item;
        const height = await aspectHeightForWidth(
          canvasId,
          src,
          item.size.width,
        );
        if (height === null || height === item.size.height) return item;
        return { ...item, size: { width: item.size.width, height } };
      }),
    );
    out.push({ ...cmd, items });
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
    /**
     * For CREATE_NODES commands, the server-assigned id of every created
     * node (with its label) so the agent can reference them in a follow-up
     * CONNECT_NODES / SET_NODE_PARENT call instead of inventing ids. Image
     * nodes additionally carry their server-derived width/height/src for
     * exact follow-up layout. Also emitted for MERGE_NODE_DATA writes that
     * change an image src.
     */
    nodes?: Array<{
      nodeId: string;
      label?: string;
      width: number;
      height: number;
      src?: string;
    }>;
    /** Server-assigned IDs for edges created by CONNECT_NODES. */
    edges?: Array<{
      edgeId: string;
      source: string;
      target: string;
    }>;
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
  viewConflicts?: InteractiveViewConflict[];
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
  let commands = preAssignIds(input.commands);

  // Normalize agent-authored `data.src` values into artifact keys BEFORE the
  // per-canvas mutex: an ACP agent may point a node at an RFS upload
  // (`upload/foo.png`) or an online URL, neither of which the web can render.
  // `importForeignNodeSources` copies / downloads the bytes into `.artifacts/`
  // and rewrites `src` to the bare key. It only reads scratch bytes and writes
  // fresh artifact files (unique ids, no topology contention), so keeping it
  // outside the mutex means a slow online download never stalls concurrent
  // writes to the same canvas. Idempotent for values that are already artifact
  // keys / `/api/` URLs / `data:` URIs.
  if (originator.source === 'agent') {
    commands = await importForeignNodeSources(canvasId, commands);

    // For image nodes with only width specified, calculate height from actual
    // image aspect ratio. This ensures correct proportions for all image sources.
    commands = await normalizeImageNodeSizes(canvasId, commands);
  }

  return await withCanvasMutex(canvasId, async () => {
    const handle = space(canvasId);
    const canvas = await handle.read();
    if (!canvas) throw new CanvasNotFoundError(canvasId);

    // Executor prestate is whole-Space work: every md-backed node in the
    // topology needs its stored content before the engine sees it.
    const records = await handle.nodes.list();

    const fromVersion = canvas.version;

    // Hydrate per-node content from .md sidecars before the engine sees
    // the prestate — handlers like MERGE_NODE_DATA need the current
    // `data.content` to merge against, but topology never carries it.
    const prestateNodes = hydrateNodes(
      records,
      canvas.state.nodes as CanvasNode[],
    );
    const prestateEdges = (canvas.state.edges ?? []) as CanvasEdge[];

    assertWorldPortalMutationsAllowed(
      canvasId,
      commands,
      prestateNodes,
      originator.source,
    );

    if (originator.source === 'agent') {
      // Order matters: fix explicit image resizes first (edits items in
      // place), then let the merge pass append geometry for src-swaps that
      // have no explicit resize. The two target disjoint node sets.
      commands = await normalizeSetGeometryImageSizes(
        canvasId,
        commands,
        prestateNodes,
      );
      commands = await normalizeMergeImageGeometry(
        canvasId,
        commands,
        prestateNodes,
      );
    }

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

    const viewConflicts = collectInteractiveViewConflicts(
      commands,
      prestateNodes,
    );
    if (viewConflicts.length > 0) {
      const conflictIds = new Set(
        viewConflicts.map((conflict) => conflict.nodeId),
      );
      return {
        canvasId,
        fromVersion,
        toVersion: fromVersion,
        deltas: [],
        results: commands.map((command) => ({
          command,
          applied: false,
          ...(command.type === 'MERGE_NODE_DATA' &&
          command.patches.some((patch) => conflictIds.has(patch.nodeId))
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
        viewConflicts,
      };
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
    assertWorldPortalResultAllowed(canvasId, prestateNodes, finalNodes);

    const deltas = diffCanvasState(
      { nodes: prestateNodes, edges: prestateEdges },
      { nodes: finalNodes, edges: finalEdges },
    );

    // Built once: id → final node, used to echo image dimensions back so
    // agents can lay out follow-up nodes with exact geometry.
    const finalById = new Map<string, CanvasNode>();
    for (const node of finalNodes) finalById.set(node.id as string, node);

    const results = commandResults.map((r) => {
      const result: ExecuteOnServerOutput['results'][0] = {
        command: r.command,
        applied: r.applied,
        ...(r.reason ? { reason: r.reason } : {}),
      };

      // Echo created node ids (+labels) so the agent can wire them up in a
      // follow-up CONNECT_NODES / SET_NODE_PARENT call with the real,
      // server-assigned ids instead of inventing ids that collide across
      // runs. Image nodes also carry server-derived dimensions/src.
      if (r.applied && r.command.type === 'CREATE_NODES') {
        const nodes = r.command.nodes
          .map((n) => {
            const node = finalById.get(n.id as string);
            if (!node) return null;
            const style = (node.style ?? {}) as Record<string, unknown>;
            const label = node.data?.label;
            return {
              nodeId: node.id as string,
              ...(typeof label === 'string' ? { label } : {}),
              width: typeof style.width === 'number' ? style.width : 0,
              height: typeof style.height === 'number' ? style.height : 0,
              ...(node.type === 'image' && typeof node.data?.src === 'string'
                ? { src: node.data.src }
                : {}),
            };
          })
          .filter((n): n is NonNullable<typeof n> => n !== null);

        if (nodes.length > 0) result.nodes = nodes;
      } else if (r.applied && r.command.type === 'CONNECT_NODES') {
        const edges = r.command.edges.flatMap((edge) =>
          edge.id
            ? [
                {
                  edgeId: edge.id,
                  source: edge.source,
                  target: edge.target,
                },
              ]
            : [],
        );
        if (edges.length > 0) result.edges = edges;
      } else if (r.applied && r.command.type === 'MERGE_NODE_DATA') {
        // Echo final image dimensions when a MERGE rewrote an image src.
        const nodes = r.command.patches
          .filter((p) => typeof p.patch?.['src'] === 'string')
          .map((p) => {
            const node = finalById.get(p.nodeId);
            if (node?.type !== 'image') return null;
            const style = (node.style ?? {}) as Record<string, unknown>;
            return {
              nodeId: p.nodeId,
              width: typeof style.width === 'number' ? style.width : 0,
              height: typeof style.height === 'number' ? style.height : 0,
              src: (node.data?.src as string) || '',
            };
          })
          .filter((n): n is NonNullable<typeof n> => n !== null);

        if (nodes.length > 0) result.nodes = nodes;
      }

      return result;
    });

    // Detect order-only mutations that `diffCanvasState` cannot see.
    //
    // `diffCanvasState` is id-keyed: it returns INSERT/DELETE/REPLACE rows
    // by comparing id sets and per-id reference identity. Commands whose
    // only effect is to reshuffle the nodes/edges array (today only
    // `REORDER_NODES`, which rebuilds the array with the same refs in a
    // new order) therefore emit zero structural deltas. Without this
    // guard the no-op fast path below would skip persistence entirely,
    // leaving the agent with `applied: true` while persisted topology
    // is unchanged.
    //
    // We do NOT synthesise a delta — Phase A has no order-aware delta
    // type, and cross-tab broadcast (M3) is not shipped yet. We just
    // fall through to the persistence branch so topology and the
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

    // Persist .md sidecars first so topology never references a markdown
    // file that does not exist on disk. The synchronous commit section is
    // wrapped in a before-image rollback: if topology or delta-log persistence
    // fails, the sidecars, record, and log prefix all return to `fromVersion`.
    //
    // `writeNode` throws `CanvasStoreIOError` on environmental failures
    // (ENOSPC, EACCES, …); we deliberately do NOT catch it so the
    // batch aborts before topology is mutated. The exception bubbles
    // through `handleCanvasCommands` and surfaces as an `isError: true`
    // tool result to the LLM (and as a 500 / error event upstream).
    // Structural `conflict` / `not-found` results are programmer errors
    // in the agent path (engine should have rejected them upstream and
    // `strictRename` is rarely set for agent-authored labels); we throw
    // a regular Error rather than letting the in-memory mutation drift
    // away from disk.
    // Pending effects preserve command order and can mention the same id in
    // both collections (DELETE then CREATE, or mutate then DELETE). Persist
    // only the effect matching the authoritative final topology so a
    // re-created node is not written and then immediately unlinked.
    const finalNodeIds = new Set(finalNodes.map((node) => node.id));
    const mutatedNodesToPersist = pendingEffects.mutatedNodes.filter((node) =>
      finalNodeIds.has(node.id),
    );
    const nodeIdsToDelete = pendingEffects.deletedNodeIds.filter(
      (nodeId) => !finalNodeIds.has(nodeId),
    );
    const insertedIds = insertedNodeIds(deltas);
    const nodeMutations: SpaceNodeMutation[] = [];
    for (const node of mutatedNodesToPersist) {
      const record = buildNodeContent(node);
      if (!record) continue;
      nodeMutations.push({
        kind: 'put',
        nodeId: record.nodeId,
        record,
        strictLabel: record['labelSource'] === 'user',
        authoritativeInsert: insertedIds.has(record.nodeId),
      });
    }
    for (const nodeId of nodeIdsToDelete) {
      nodeMutations.push({ kind: 'delete', nodeId });
    }

    const nextCanvas: CanvasFile = {
      ...canvas,
      version: toVersion,
      state: {
        ...canvas.state,
        nodes: stripNodesForCanvas(finalNodes),
        edges: finalEdges,
      },
      updatedAt: Date.now(),
    };
    const logEntry: DeltaLogEntry = {
      version: toVersion,
      ts: Date.now(),
      ...(runId ? { runId } : {}),
      commands: commands as unknown[],
      deltas: deltas as unknown[],
      originator,
    };
    const write = await handle.write({
      expectedVersion: fromVersion,
      nextRecord: nextCanvas,
      nodeMutations,
      delta: logEntry,
    });
    if (!write.ok) {
      if (write.reason === 'not-found') {
        throw new CanvasNotFoundError(canvasId);
      }
      throw new Error(
        `[canvas-executor] ordered Space write rejected: ${write.reason}`,
      );
    }

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
        broadcastChanges = await handle.changes.append(
          originator.threadId,
          changes,
        );
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
 * persist content + topology → append delta-log → bump version) but
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
    const handle = space(canvasId);
    const canvas = await handle.read();
    if (!canvas) throw new CanvasNotFoundError(canvasId);

    // Executor prestate is whole-Space work: every md-backed node in the
    // topology needs its stored content before the engine sees it.
    const records = await handle.nodes.list();

    const fromVersion = canvas.version;
    const prestateNodes = hydrateNodes(
      records,
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
      } else if (d.type === 'DELETE_NODE') {
        deletedNodeIds.push(d.node.id);
      }
    }
    const insertedIds = insertedNodeIds(deltas);
    const nodeMutations: SpaceNodeMutation[] = [];
    for (const d of deltas) {
      if (d.type === 'INSERT_NODE' || d.type === 'REPLACE_NODE') {
        const node = d.type === 'INSERT_NODE' ? d.node : d.next;
        const record = buildNodeContent(node);
        if (record) {
          nodeMutations.push({
            kind: 'put',
            nodeId: record.nodeId,
            record,
            strictLabel: record['labelSource'] === 'user',
            authoritativeInsert: insertedIds.has(record.nodeId),
          });
        }
      } else if (d.type === 'DELETE_NODE') {
        nodeMutations.push({ kind: 'delete', nodeId: d.node.id });
      }
    }

    const nextRecord: CanvasFile = {
      ...canvas,
      version: toVersion,
      state: {
        ...canvas.state,
        nodes: stripNodesForCanvas(finalNodes),
        edges: finalEdges,
      },
      updatedAt: Date.now(),
    };
    const write = await handle.write({
      expectedVersion: fromVersion,
      nextRecord,
      nodeMutations,
      delta: {
        version: toVersion,
        ts: Date.now(),
        ...(runId ? { runId } : {}),
        commands: [],
        deltas: deltas as unknown[],
        originator,
      },
    });
    if (!write.ok) {
      if (write.reason === 'not-found') {
        throw new CanvasNotFoundError(canvasId);
      }
      throw new Error(
        `[canvas-executor] ordered Space write rejected: ${write.reason}`,
      );
    }

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
