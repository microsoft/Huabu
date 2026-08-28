// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canvas → spatial / topological helpers.
 *
 * Backs the `get_canvas_outline`, `inspect_nodes`, and `inspect_edges`
 * agent tools. The split is deliberate (see
 * docs/architecture/agent-architecture.md):
 *
 *  - `get_canvas_outline`  →  `buildCanvasOutline()` — one-shot "map"
 *    of the whole canvas: every node's geometry/parent/(opt-in) style
 *    + topology-only edge list (`{id, source, target}`) + pre-computed
 *    spatial clusters.
 *  - `inspect_nodes`        →  `inspectNodes()` — predicate-driven
 *    node lookup (attribute / spatial / topological), returning each
 *    match with its full geometry + style + per-predicate derived
 *    fields (distance, direction, edgeIds, …).
 *  - `inspect_edges`        →  `inspectEdges()` — predicate-driven
 *    edge lookup (by id / endpoints / EdgeStyle attributes). Use this
 *    when you need the visual style or want to filter edges by
 *    direction / line style — outline only carries topology.
 *
 * Heavy lifting (clustering, proximity, arrangement detection) lives
 * in the zero-dep shared library `@huabu/shared/utils/spatial`.
 * This module is just an adapter: it loads persisted topology, normalizes
 * node sizes via the canvas-engine helper
 * (`@huabu/shared/canvas-engine/utils/nodeSizes.ts → getNodeSize`),
 * resolves absolute positions for nested nodes, then forwards to the
 * shared primitives.
 *
 * Boundary with `read`:
 *   - `read("nodes/<nodeId>.md")` owns content/label/summary/
 *     keywords (the markdown frontmatter).
 *   - This module owns structural fields: position, size,
 *     parent, visual style on `data.style`, edge endpoints +
 *     `data.edgeStyle`, plus all derived spatial/topological metadata.
 *   - When `includePreviews` is set, outline pulls the preview text
 *     via `CanvasStore.readNode` — the only place it crosses into the
 *     markdown side, kept gated behind an opt-in flag.
 */

import {
  buildSpatialSummary,
  detectArrangement,
  findNearbyNodes,
  nodesInRect,
  sortByReadingOrder,
} from '@huabu/shared';
import {
  getLayoutNodeSize,
  type CanvasNode,
} from '@huabu/shared/canvas-engine';

import { describeNode, nodeLabel, type NodeInput } from './node-prompt.js';
import { space } from '../storage/index.js';

import type { AgentNodeOutline } from '../agent/node-ref.js';
import type { CanvasFile } from '../storage/index.js';
import type {
  CanvasNodeType,
  CardinalDirection,
  EdgeDirection,
  EdgeLineStyle,
  EdgeLineType,
  EdgeStrokeWidth,
  EdgeStyle,
  LabelSource,
  SpatialNode,
} from '@huabu/shared';

// ─── Loosely parsed topology shapes ─────────────────────────────────────────
//
// Nodes are typed as the canonical {@link CanvasNode} (= ReactFlow
// `Node`); we narrow `data` field-by-field at the read site because
// Persisted edges are generic JSON objects and still need
// a narrow shim below because xyflow's `Edge['data']` does not know
// about our {@link EdgeStyle} sub-object — the canonical edge style
// lives in `@huabu/shared`.

interface RawEdge {
  id?: string;
  source: string;
  target: string;
  /**
   * React Flow render props (stroke, strokeWidth, strokeDasharray, ...)
   * — derived from `data.edgeStyle` by `applyEdgeStyle`. Do **not**
   * surface this to agents; it duplicates and partially mirrors
   * `data.edgeStyle`, which is the canonical source of truth.
   */
  style?: Record<string, unknown>;
  data?: {
    /** Source-of-truth `EdgeStyle` written by `applyEdgeStyle`. */
    edgeStyle?: EdgeStyle;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ─── Position normalization ────────────────────────────────────────────────

/**
 * Walk the parent chain to express the node's position in absolute
 * Space coordinates. Persisted positions are relative to the
 * parent frame; agents reasoning about proximity want absolutes.
 */
function resolveAbsolutePosition(
  node: CanvasNode,
  byId: ReadonlyMap<string, CanvasNode>,
): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let cur: CanvasNode | undefined = node;
  while (cur) {
    x += cur.position?.x ?? 0;
    y += cur.position?.y ?? 0;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return { x, y };
}

// ─── Bundle: one-pass parse for both outline and inspect ────────────────────

export interface SpatialBundle {
  /** Shared-lib-shaped spatial nodes (already absolute, with size fallbacks). */
  spatialNodes: SpatialNode[];
  /** Edge endpoints in the shape the shared spatial helpers expect. */
  edges: Array<{ source: string; target: string }>;
  /**
   * Lookup back to the raw on-disk node (for style / data.label / etc.).
   */
  rawById: Map<string, CanvasNode>;
  /** Lookup of spatial nodes by id — handy for proximity targets. */
  spatialById: Map<string, SpatialNode>;
  /** Original edge entries (preserves id + style for outline output). */
  rawEdges: RawEdge[];
}

/**
 * Parse a canvas file into the normalised spatial shape consumed by
 * outline / inspect / node-neighbourhood. Exported so server modules
 * outside this file can build the bundle once and forward to their
 * own analysis (instead of re-implementing size + position fallbacks).
 */
export function buildSpatialBundle(canvas: CanvasFile): SpatialBundle {
  const rawNodes = (canvas.state.nodes ?? []) as CanvasNode[];
  const rawEdges = (canvas.state.edges ?? []) as RawEdge[];
  const byId = new Map(rawNodes.map((n) => [n.id, n]));

  const spatialNodes: SpatialNode[] = rawNodes.map((n) => {
    // `getLayoutNodeSize` applies the same `measured → style` priority
    // the web UI uses, then falls back to 200×100 so unmeasured nodes
    // still cluster sanely.
    const { w, h } = getLayoutNodeSize(n);
    const abs = resolveAbsolutePosition(n, byId);
    return {
      id: n.id,
      rect: { x: abs.x, y: abs.y, width: w, height: h },
      type: n.type,
      parentId: n.parentId ?? null,
      label: typeof n.data?.label === 'string' ? n.data.label : undefined,
    };
  });
  const spatialById = new Map(spatialNodes.map((s) => [s.id, s]));
  const edges = rawEdges.map((e) => ({ source: e.source, target: e.target }));
  return { spatialNodes, edges, rawById: byId, spatialById, rawEdges };
}

// ─── Helpers shared by outline + inspect ────────────────────────────────────

function readVisualStyle(
  raw: CanvasNode | undefined,
): Record<string, unknown> | undefined {
  const s = raw?.data?.style;
  return s && typeof s === 'object'
    ? (s as Record<string, unknown>)
    : undefined;
}

/**
 * Build the shared `describeNode` input for a spatial node: type + inline
 * `content` / `src` + the dual coordinate contract + size + `parentFrame`.
 *
 * Coordinates: `position` is parent-local (the raw stored value);
 * `absolutePosition` is the parent-chain-resolved world coordinate. They
 * coincide for root nodes.
 *
 * `style` is layered on by the caller — opt-in for outline, always for
 * inspect — so it is deliberately left off here.
 */
function spatialNodeInput(
  s: SpatialNode,
  raw: CanvasNode | undefined,
  parentLabel: string | undefined,
): NodeInput {
  const rawData = raw?.data as Record<string, unknown> | undefined;
  return {
    id: s.id,
    type: (s.type ?? raw?.type ?? 'note') as CanvasNodeType,
    ...(typeof rawData?.['content'] === 'string'
      ? { content: rawData['content'] as string }
      : {}),
    ...(typeof rawData?.['src'] === 'string'
      ? { src: rawData['src'] as string }
      : {}),
    ...(typeof rawData?.['targetCanvasId'] === 'string'
      ? { targetCanvasId: rawData['targetCanvasId'] }
      : {}),
    ...(rawData?.['target'] &&
    typeof rawData['target'] === 'object' &&
    typeof (rawData['target'] as Record<string, unknown>)['canvasId'] ===
      'string' &&
    typeof (rawData['target'] as Record<string, unknown>)['nodeId'] === 'string'
      ? {
          target: {
            canvasId: (rawData['target'] as Record<string, string>)['canvasId'],
            nodeId: (rawData['target'] as Record<string, string>)['nodeId'],
          },
        }
      : {}),
    position: raw?.position,
    absolutePosition: { x: s.rect.x, y: s.rect.y },
    size: { width: s.rect.width, height: s.rect.height },
    ...(s.parentId
      ? {
          parentFrame: {
            id: s.parentId,
            ...(parentLabel ? { label: parentLabel } : {}),
          },
        }
      : {}),
  };
}

// ─── Public: get_canvas_outline ─────────────────────────────────────────────

/**
 * Outline node payload. Aliased to {@link AgentNodeOutline} so every
 * canvas → LLM hand-off shares the same `id / type / label / filename
 * / preview? / parentFrame? / position / size / style?` shape — the
 * unified L2 rung of the agent node-ref ladder.
 *
 * `style` and `preview` remain opt-in (gated by `CanvasOutlineOpts`)
 * to keep the default outline payload lean.
 */
export type CanvasOutlineNode = AgentNodeOutline;

export interface CanvasOutlineEdge {
  /**
   * Outline carries only topology (id + endpoints). For an edge's
   * EdgeStyle fields (lineType / lineStyle / direction / stroke /
   * strokeWidth), use `inspect_edges` — keeps outline lean and avoids
   * paying the EdgeStyle vocabulary cost on every "orient yourself"
   * call.
   */
  id?: string;
  source: string;
  target: string;
}

export interface CanvasOutlineCluster {
  frameId?: string;
  frameLabel?: string;
  nodeIds: string[];
  arrangement: string;
}

export interface CanvasOutline {
  version: number;
  bbox: { x: number; y: number; width: number; height: number } | null;
  nodes: CanvasOutlineNode[];
  edges: CanvasOutlineEdge[];
  spatial: { clusters: CanvasOutlineCluster[] };
}

export interface CanvasOutlineOpts {
  includePreviews?: boolean;
  includeStyle?: boolean;
}

/**
 * Build the one-shot "map" of a canvas: every node's geometry + edges +
 * spatial clusters. Returns `null` when the canvas does not exist.
 */
export async function buildCanvasOutline(
  canvasId: string,
  opts: CanvasOutlineOpts = {},
): Promise<CanvasOutline | null> {
  const handle = space(canvasId);
  const canvas = await handle.read();
  if (!canvas) return null;

  // Whole-Space work: the outline describes every node, so one scan is the
  // shape (§12.6.1). It also replaces the lazy per-node reads the memo below
  // used to guard, which no async port could serve from inside a synchronous
  // map.
  const records = await handle.nodes.list();

  const bundle = buildSpatialBundle(canvas);
  const summary = buildSpatialSummary(bundle.spatialNodes, bundle.edges);

  // Whole-canvas bbox; null when empty.
  let bbox: CanvasOutline['bbox'] = null;
  if (bundle.spatialNodes.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of bundle.spatialNodes) {
      minX = Math.min(minX, s.rect.x);
      minY = Math.min(minY, s.rect.y);
      maxX = Math.max(maxX, s.rect.x + s.rect.width);
      maxY = Math.max(maxY, s.rect.y + s.rect.height);
    }
    bbox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  // Resolve display labels from the sidecar (topology never carries
  // them), memoized so a frame referenced as many nodes' parent is read once.
  const labelOf = (id: string): string | undefined =>
    nodeLabel(records.get(id)?.record ?? null);

  const nodes: CanvasOutlineNode[] = bundle.spatialNodes.map((s) => {
    const raw = bundle.rawById.get(s.id);
    const parentLabel = s.parentId ? labelOf(s.parentId) : undefined;
    const style = opts.includeStyle ? readVisualStyle(raw) : undefined;
    const out: CanvasOutlineNode = describeNode(
      {
        ...spatialNodeInput(s, raw, parentLabel),
        ...(style ? { style } : {}),
      },
      'outline',
      records.get(s.id)?.record ?? null,
    );
    // The shared builder attaches `summary` (authored abstract) and
    // `preview` (raw body excerpt) from the sidecar; both are text scan
    // hints, so strip them when the caller did not opt in to previews and
    // the outline payload should stay lean (geometry + topology only).
    if (!opts.includePreviews) {
      delete out.summary;
      delete out.preview;
    }
    return out;
  });

  const edges: CanvasOutlineEdge[] = bundle.rawEdges.map((e) => {
    const out: CanvasOutlineEdge = { source: e.source, target: e.target };
    if (e.id) out.id = e.id;
    return out;
  });

  const clusters: CanvasOutlineCluster[] = summary.clusters.map((c) => {
    const out: CanvasOutlineCluster = {
      nodeIds: c.nodeIds,
      arrangement: c.arrangement,
    };
    if (c.frameId) out.frameId = c.frameId;
    if (c.frameLabel) out.frameLabel = c.frameLabel;
    return out;
  });

  return {
    version: canvas.version,
    bbox,
    nodes,
    edges,
    spatial: { clusters },
  };
}

// ─── Public: inspect_nodes ──────────────────────────────────────────────────

export interface InspectNodesArgs {
  // Attribute predicates
  ids?: string[];
  byType?: string | string[];
  /** `null` = top-level only (no parent). */
  byParent?: string | null;
  /** Regex pattern matched against `data.label`. */
  labelPattern?: string;

  // Spatial predicates
  inRect?: { x: number; y: number; width: number; height: number };
  nearNode?: {
    id: string;
    maxDistance?: number;
    maxCount?: number;
    sameParent?: boolean;
  };
  nearPoint?: {
    x: number;
    y: number;
    maxDistance?: number;
    maxCount?: number;
  };
  inSameClusterAs?: string;

  // Topological predicates
  connectedTo?: { id: string; depth?: 1 | 2 };

  // Output controls
  sort?: 'distance' | 'reading-order' | 'area';
  limit?: number;
}

/**
 * Per-match inspect row. Extends the unified {@link AgentNodeOutline}
 * shape so callers see the same `id / type / label / filename /
 * preview? / parentFrame? / position / size / style?` fields they get
 * from `get_canvas_outline`, plus the predicate-derived spatial /
 * topological annotations below.
 *
 * `style` is always emitted by inspect (no opt-in flag — predicate
 * queries already imply the caller wants per-node detail). `preview`
 * is omitted; use `get_canvas_outline({ includePreviews: true })` or
 * `read("nodes/<file>.md")` for content.
 */
export interface InspectNodeResult extends AgentNodeOutline {
  // Per-predicate derived fields (only set when relevant predicate ran).
  distance?: number;
  centerDistance?: number;
  direction?: CardinalDirection;
  edgeIds?: string[];
  hops?: 1 | 2;
  clusterId?: string;
}

export interface InspectNodesResult {
  /** Number of nodes returned in this response (`<= limit`). */
  count: number;
  /** Total number of matches before `limit` was applied. */
  total: number;
  /** True when `total > count`; raise `limit` or refine the query. */
  truncated: boolean;
  /** Arrangement description; emitted only when `count >= 2`. */
  arrangement?: string;
  nodes: InspectNodeResult[];
}

export type InspectNodesError = { error: string };

const DEFAULT_INSPECT_LIMIT = 50;

/**
 * Run a multi-predicate query against a canvas's nodes.
 *
 * Predicates are *ANDed*: each filter intersects the previous candidate
 * set. When no predicate is supplied at all, the result is every node
 * (subject to `limit`). Per-predicate derived fields (distance,
 * direction, edgeIds, hops, clusterId) are computed during filtering
 * and merged into the final result row.
 */
export async function inspectNodes(
  canvasId: string,
  args: InspectNodesArgs,
): Promise<InspectNodesResult | InspectNodesError> {
  const handle = space(canvasId);
  const canvas = await handle.read();
  if (!canvas) return { error: `Canvas ${canvasId} not found` };

  const bundle = buildSpatialBundle(canvas);
  // An unfiltered inspect returns every node, and `labelPattern` has to test
  // every candidate, so the candidate set is the Space (§12.6.1).
  const records = await handle.nodes.list();

  // Display labels come from the sidecar (topology never carries them);
  // memoize so the `labelPattern` filter and the result map read each once.
  const memoLabel = (id: string): string | undefined =>
    nodeLabel(records.get(id)?.record ?? null);

  // Per-node derived fields accumulated during filter passes.
  const derived = new Map<string, Partial<InspectNodeResult>>();
  const setDerived = (id: string, patch: Partial<InspectNodeResult>) => {
    derived.set(id, { ...derived.get(id), ...patch });
  };

  // Candidate ID set; null = "no filter applied yet" → universe = all nodes.
  let candidateIds: Set<string> | null = null;
  const intersect = (next: Iterable<string>) => {
    const nextSet = next instanceof Set ? next : new Set(next);
    if (candidateIds === null) {
      candidateIds = nextSet;
    } else {
      const out = new Set<string>();
      for (const id of candidateIds) if (nextSet.has(id)) out.add(id);
      candidateIds = out;
    }
  };

  // Track whether any near* predicate ran, so we know to default-sort by
  // distance when the caller didn't pick a sort.
  let usedProximity = false;

  // ── ids ──
  if (args.ids) intersect(args.ids);

  // ── byType ──
  if (args.byType !== undefined) {
    const types = new Set(
      Array.isArray(args.byType) ? args.byType : [args.byType],
    );
    const hits: string[] = [];
    for (const s of bundle.spatialNodes) {
      if (s.type && types.has(s.type)) hits.push(s.id);
    }
    intersect(hits);
  }

  // ── byParent (null = top-level) ──
  if (args.byParent !== undefined) {
    const target = args.byParent;
    const hits: string[] = [];
    for (const s of bundle.spatialNodes) {
      const p = s.parentId ?? null;
      if (target === null ? p === null : p === target) hits.push(s.id);
    }
    intersect(hits);
  }

  // ── labelPattern ──
  if (args.labelPattern) {
    let re: RegExp;
    try {
      re = new RegExp(args.labelPattern);
    } catch (err) {
      return { error: `Invalid labelPattern: ${(err as Error).message}` };
    }
    const hits: string[] = [];
    for (const s of bundle.spatialNodes) {
      const label = memoLabel(s.id);
      if (label && re.test(label)) hits.push(s.id);
    }
    intersect(hits);
  }

  // ── inRect (center-hit) ──
  if (args.inRect) {
    const hits = nodesInRect(bundle.spatialNodes, args.inRect).map((n) => n.id);
    intersect(hits);
  }

  // ── nearNode ──
  if (args.nearNode) {
    const target = bundle.spatialById.get(args.nearNode.id);
    if (!target) {
      return { error: `Node ${args.nearNode.id} not found (used in nearNode)` };
    }
    const candidates = args.nearNode.sameParent
      ? bundle.spatialNodes.filter(
          (n) => (n.parentId ?? null) === (target.parentId ?? null),
        )
      : bundle.spatialNodes;
    const results = findNearbyNodes(target, candidates, {
      maxCount: args.nearNode.maxCount,
      maxDistance: args.nearNode.maxDistance,
    });
    const ids: string[] = [];
    for (const r of results) {
      ids.push(r.node.id);
      setDerived(r.node.id, {
        distance: Math.round(r.distance),
        centerDistance: Math.round(r.centerDistance),
        direction: r.direction,
      });
    }
    intersect(ids);
    usedProximity = true;
  }

  // ── nearPoint ──
  if (args.nearPoint) {
    // Build a synthetic 0-size SpatialNode at the point so we can reuse
    // findNearbyNodes' edge-distance + direction logic.
    const synthetic: SpatialNode = {
      id: '__inspect_point__',
      rect: { x: args.nearPoint.x, y: args.nearPoint.y, width: 0, height: 0 },
    };
    const results = findNearbyNodes(synthetic, bundle.spatialNodes, {
      maxCount: args.nearPoint.maxCount,
      maxDistance: args.nearPoint.maxDistance,
    });
    const ids: string[] = [];
    for (const r of results) {
      ids.push(r.node.id);
      setDerived(r.node.id, {
        distance: Math.round(r.distance),
        centerDistance: Math.round(r.centerDistance),
        direction: r.direction,
      });
    }
    intersect(ids);
    usedProximity = true;
  }

  // ── inSameClusterAs ──
  if (args.inSameClusterAs) {
    const targetId = args.inSameClusterAs;
    if (!bundle.spatialById.has(targetId)) {
      return {
        error: `Node ${targetId} not found (used in inSameClusterAs)`,
      };
    }
    const summary = buildSpatialSummary(bundle.spatialNodes, bundle.edges);
    const idx = summary.clusters.findIndex((c) => c.nodeIds.includes(targetId));
    if (idx < 0) {
      // Target is isolated → no siblings.
      intersect([]);
    } else {
      const cluster = summary.clusters[idx];
      const ids = cluster.nodeIds.filter((id) => id !== targetId);
      const cid = cluster.frameId ?? `cluster-${idx}`;
      for (const id of ids) setDerived(id, { clusterId: cid });
      intersect(ids);
    }
  }

  // ── connectedTo ──
  if (args.connectedTo) {
    const targetId = args.connectedTo.id;
    if (!bundle.spatialById.has(targetId)) {
      return {
        error: `Node ${targetId} not found (used in connectedTo)`,
      };
    }
    const depth = args.connectedTo.depth ?? 1;

    // 1-hop adjacency.
    const hop1 = new Map<string, string[]>();
    for (const e of bundle.rawEdges) {
      const eid = e.id ?? `${e.source}->${e.target}`;
      const other =
        e.source === targetId && e.target !== targetId
          ? e.target
          : e.target === targetId && e.source !== targetId
            ? e.source
            : null;
      if (!other) continue;
      const list = hop1.get(other) ?? [];
      list.push(eid);
      hop1.set(other, list);
    }
    const ids: string[] = [];
    for (const [nid, eids] of hop1) {
      ids.push(nid);
      setDerived(nid, { edgeIds: eids, hops: 1 });
    }

    // Optional 2-hop expansion. Only adds nodes not already in hop-1, but
    // collects every edge that reaches each 2-hop node (a node may be
    // reachable through multiple hop-1 neighbours, and the model relies on
    // edgeIds to enumerate connectors).
    if (depth === 2) {
      const hop1Set = new Set<string>(ids);
      const excluded = new Set<string>([targetId, ...ids]);
      const hop2Edges = new Map<string, string[]>();
      for (const hop1Id of ids) {
        for (const e of bundle.rawEdges) {
          const other =
            e.source === hop1Id
              ? e.target
              : e.target === hop1Id
                ? e.source
                : null;
          if (!other || excluded.has(other)) continue;
          // Skip edges that link two hop-1 nodes (already represented in hop-1).
          if (hop1Set.has(other)) continue;
          const eid = e.id ?? `${e.source}->${e.target}`;
          const list = hop2Edges.get(other) ?? [];
          if (!list.includes(eid)) list.push(eid);
          hop2Edges.set(other, list);
        }
      }
      for (const [nid, eids] of hop2Edges) {
        setDerived(nid, { edgeIds: eids, hops: 2 });
        ids.push(nid);
      }
    }
    intersect(ids);
  }

  // No predicate at all → every node.
  if (candidateIds === null) {
    candidateIds = new Set(bundle.spatialNodes.map((n) => n.id));
  }

  let resultNodes = bundle.spatialNodes.filter((s) =>
    (candidateIds as Set<string>).has(s.id),
  );

  // Sort. Default to distance when a near* predicate ran.
  const sortKey = args.sort ?? (usedProximity ? 'distance' : undefined);
  if (sortKey === 'distance') {
    resultNodes.sort((a, b) => {
      const da = derived.get(a.id)?.distance ?? Infinity;
      const db = derived.get(b.id)?.distance ?? Infinity;
      return da - db;
    });
  } else if (sortKey === 'reading-order') {
    resultNodes = sortByReadingOrder(resultNodes);
  } else if (sortKey === 'area') {
    resultNodes.sort(
      (a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height,
    );
  }

  const limit = Math.max(1, args.limit ?? DEFAULT_INSPECT_LIMIT);
  const total = resultNodes.length;
  const truncated = total > limit;
  if (truncated) resultNodes = resultNodes.slice(0, limit);

  const nodes: InspectNodeResult[] = resultNodes.map((s) => {
    const raw = bundle.rawById.get(s.id);
    const parentLabel = s.parentId ? memoLabel(s.parentId) : undefined;
    const base = describeNode(
      spatialNodeInput(s, raw, parentLabel),
      'outline',
      records.get(s.id)?.record ?? null,
    );
    // Inspect deliberately omits text hints (`summary` / `preview`); agents
    // that need text use `get_canvas_outline({ includePreviews: true })` or
    // `read`.
    delete base.summary;
    delete base.preview;
    const result: InspectNodeResult = base;
    const style = readVisualStyle(raw);
    if (style) result.style = style;
    const d = derived.get(s.id);
    if (d) {
      if (d.distance !== undefined) result.distance = d.distance;
      if (d.centerDistance !== undefined)
        result.centerDistance = d.centerDistance;
      if (d.direction) result.direction = d.direction;
      if (d.edgeIds) result.edgeIds = d.edgeIds;
      if (d.hops) result.hops = d.hops;
      if (d.clusterId) result.clusterId = d.clusterId;
    }
    return result;
  });

  const arrangement =
    nodes.length >= 2 ? detectArrangement(resultNodes) : undefined;

  return {
    count: nodes.length,
    total,
    truncated,
    ...(arrangement ? { arrangement } : {}),
    nodes,
  };
}

// ─── Public: inspect_edges ──────────────────────────────────────────────────

export interface InspectEdgesArgs {
  // Identity / endpoint predicates
  ids?: string[];
  /** Match all edges incident to this node (source OR target). */
  connectedTo?: string;
  /** Match outgoing edges of this node. */
  bySource?: string;
  /** Match incoming edges of this node. */
  byTarget?: string;
  /** Match edges between these two nodes (either direction). */
  between?: { a: string; b: string };

  // EdgeStyle predicates
  byDirection?: EdgeDirection | EdgeDirection[];
  byLineStyle?: EdgeLineStyle | EdgeLineStyle[];
  byLineType?: EdgeLineType | EdgeLineType[];
  /**
   * Substring match (case-insensitive) on the edge label. Useful for
   * agents that want to find e.g. "all edges labelled 'blocks'".
   * Edges with no label never match.
   */
  byLabel?: string;

  limit?: number;
}

export interface InspectEdgeResult {
  id?: string;
  source: string;
  target: string;
  // EdgeStyle fields, omitted when unset on disk.
  lineType?: EdgeLineType;
  lineStyle?: EdgeLineStyle;
  /** Palette accent token (e.g. `'purple'`) or a literal CSS color. */
  stroke?: string;
  strokeWidth?: EdgeStrokeWidth | number;
  direction?: EdgeDirection;
  /** Text rendered at the edge midpoint. Omitted when no label is set. */
  label?: string;
  /** Who last set the label. Omitted when no label is set. */
  labelSource?: LabelSource;
}

export interface InspectEdgesResult {
  /** Number of edges returned in this response (`<= limit`). */
  count: number;
  /** Total number of matches before `limit` was applied. */
  total: number;
  /** True when `total > count`; raise `limit` or refine the query. */
  truncated: boolean;
  edges: InspectEdgeResult[];
}

export type InspectEdgesError = { error: string };

/**
 * Run a multi-predicate query against a canvas's edges.
 *
 * Predicates are *ANDed*. With no predicate at all, every edge is
 * returned (subject to `limit`) — agents typically end up here from
 * `inspect_nodes({ connectedTo }).edgeIds` or directly from a styling
 * task, so even the unfiltered case is bounded in practice.
 */
export async function inspectEdges(
  canvasId: string,
  args: InspectEdgesArgs,
): Promise<InspectEdgesResult | InspectEdgesError> {
  const canvas = await space(canvasId).read();
  if (!canvas) return { error: `Canvas ${canvasId} not found` };

  const bundle = buildSpatialBundle(canvas);
  const nodeIds = new Set(bundle.spatialNodes.map((s) => s.id));

  // Validate referenced nodes up front so the agent gets a clear
  // error instead of a silent zero-hit result.
  const checkNode = (id: string, where: string): InspectEdgesError | null =>
    nodeIds.has(id)
      ? null
      : { error: `Node ${id} not found (used in ${where})` };

  if (args.connectedTo) {
    const err = checkNode(args.connectedTo, 'connectedTo');
    if (err) return err;
  }
  if (args.bySource) {
    const err = checkNode(args.bySource, 'bySource');
    if (err) return err;
  }
  if (args.byTarget) {
    const err = checkNode(args.byTarget, 'byTarget');
    if (err) return err;
  }
  if (args.between) {
    const errA = checkNode(args.between.a, 'between.a');
    if (errA) return errA;
    const errB = checkNode(args.between.b, 'between.b');
    if (errB) return errB;
  }

  const idsFilter = args.ids ? new Set(args.ids) : null;
  const directions = args.byDirection
    ? new Set(
        Array.isArray(args.byDirection) ? args.byDirection : [args.byDirection],
      )
    : null;
  const lineStyles = args.byLineStyle
    ? new Set(
        Array.isArray(args.byLineStyle) ? args.byLineStyle : [args.byLineStyle],
      )
    : null;
  const lineTypes = args.byLineType
    ? new Set(
        Array.isArray(args.byLineType) ? args.byLineType : [args.byLineType],
      )
    : null;
  const labelNeedle =
    typeof args.byLabel === 'string' && args.byLabel.length > 0
      ? args.byLabel.toLowerCase()
      : null;

  const matched: InspectEdgeResult[] = [];
  for (const e of bundle.rawEdges) {
    if (idsFilter) {
      if (!e.id || !idsFilter.has(e.id)) continue;
    }
    if (args.connectedTo) {
      if (e.source !== args.connectedTo && e.target !== args.connectedTo) {
        continue;
      }
    }
    if (args.bySource && e.source !== args.bySource) continue;
    if (args.byTarget && e.target !== args.byTarget) continue;
    if (args.between) {
      const { a, b } = args.between;
      const matches =
        (e.source === a && e.target === b) ||
        (e.source === b && e.target === a);
      if (!matches) continue;
    }

    const style = e.data?.edgeStyle;
    if (directions) {
      // Treat absence as 'none' (the default direction).
      const d = style?.direction ?? 'none';
      if (!directions.has(d)) continue;
    }
    if (lineStyles) {
      const ls = style?.lineStyle ?? 'solid';
      if (!lineStyles.has(ls)) continue;
    }
    if (lineTypes) {
      const lt = style?.lineType ?? 'bezier';
      if (!lineTypes.has(lt)) continue;
    }
    if (labelNeedle) {
      const label = typeof style?.label === 'string' ? style.label : '';
      if (!label.toLowerCase().includes(labelNeedle)) continue;
    }

    const out: InspectEdgeResult = { source: e.source, target: e.target };
    if (e.id) out.id = e.id;
    if (style && typeof style === 'object') {
      if (style.lineType) out.lineType = style.lineType;
      if (style.lineStyle) out.lineStyle = style.lineStyle;
      if (style.stroke !== undefined) out.stroke = style.stroke;
      if (style.strokeWidth !== undefined) out.strokeWidth = style.strokeWidth;
      if (style.direction) out.direction = style.direction;
      if (typeof style.label === 'string' && style.label.length > 0) {
        out.label = style.label;
        if (style.labelSource) out.labelSource = style.labelSource;
      }
    }
    matched.push(out);
  }

  const limit = Math.max(1, args.limit ?? DEFAULT_INSPECT_LIMIT);
  const total = matched.length;
  const truncated = total > limit;
  const edges = truncated ? matched.slice(0, limit) : matched;
  return { count: edges.length, total, truncated, edges };
}
