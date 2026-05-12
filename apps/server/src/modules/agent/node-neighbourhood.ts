/**
 * Node-neighbourhood preamble for the Ask agent.
 *
 * Self-contained pipeline (algorithm + adapter + renderer) that
 * answers the question "what is around node X on canvas Y?" and
 * formats the answer as the Markdown block injected into the Ask
 * agent's `nodeNeighbourhoodPreamble` template.
 *
 *   1. Algorithm — `buildNodeNeighbourhoodContext` walks inside-out
 *      (frame → grandframe → canvas) and produces a structured
 *      `NodeNeighbourhoodContext`.
 *   2. Adapter  — `getNodeNeighbourhood(canvasId, anchorNodeId)`
 *      loads the canvas, normalises geometry via the shared
 *      `buildSpatialBundle`, owns the snippet-extraction policy
 *      (label > content[:120] > src), and feeds the algorithm.
 *   3. Renderer — `renderNodeNeighbourhoodMarkdown(canvasId,
 *      anchorNodeId)` is the public entry point: serialises the
 *      structured context into the Markdown block consumed by the
 *      AGENT.md template.
 *
 * Originally driven by question nodes (`useQuestionRunner` ships the
 * question node id as the anchor), but anchor-type agnostic.
 *
 * Lives outside `packages/shared` because nothing on the web bundle
 * currently consumes it; keeping it server-side keeps the prompt-
 * shaped algorithm beside its sole call site.
 */

import {
  detectArrangement,
  findClusters,
  rectCenter,
  rectEdgeDistance,
  sortByReadingOrder,
} from '@sediment/shared';

import { buildSpatialBundle } from '../canvas/canvas-spatial.js';
import { getCanvasStore } from '../storage/index.js';

import type { SpatialNode } from '@sediment/shared';

// ─── Public entry point ─────────────────────────────────────────────────────

/**
 * Build the Markdown block for the `nodeNeighbourhoodPreamble.spatial`
 * template variable. Returns an empty string when no preamble should
 * be pushed (canvas missing, anchor missing, or no useful context).
 */
export function renderNodeNeighbourhoodMarkdown(
  canvasId: string,
  anchorNodeId: string,
): string {
  const ctx = getNodeNeighbourhood(canvasId, anchorNodeId);
  if (!ctx) return '';
  return serializeNodeNeighbourhoodContext(ctx);
}

// ─── Adapter: canvasId + anchorNodeId → NodeNeighbourhoodContext ────────────

/**
 * Build the {@link NodeNeighbourhoodContext} centred on any node by
 * loading its canvas, normalising geometry, and forwarding to the
 * algorithm below.
 *
 * Returns `null` when the canvas or the anchor node cannot be found
 * — e.g. the node was deleted between the client firing and the
 * request landing. Callers should treat this as "no neighbourhood".
 *
 * Owns the snippet-extraction policy. The ladder mirrors what the
 * canvas surfaces visually, so the agent sees the same sliver that
 * anchors each surrounding node:
 *
 *   1. Inline `data.label / data.content / data.src` — text-on-canvas
 *      nodes (text/image/web/...) carry their visible content here.
 *   2. Markdown frontmatter via `readNode`: `summary > keywords > content[:120]`
 *      — note nodes (and other source-backed nodes) keep their body in
 *      `nodes/<file>.md`, so the inline shape is empty and we have to
 *      reach into storage.
 *
 * The disk hit is wrapped in a memoized resolver so we only pay for
 * nodes the algorithm actually surfaces (typically ≪ canvas size).
 */
export function getNodeNeighbourhood(
  canvasId: string,
  anchorNodeId: string,
): NodeNeighbourhoodContext | null {
  const canvas = getCanvasStore(canvasId).read();
  if (!canvas) return null;
  const bundle = buildSpatialBundle(canvas);
  const target = bundle.spatialNodes.find((n) => n.id === anchorNodeId);
  if (!target) return null;

  const store = getCanvasStore(canvasId);
  const cache = new Map<string, string | undefined>();
  const getSnippet = (nodeId: string): string | undefined => {
    if (cache.has(nodeId)) return cache.get(nodeId);

    const raw = bundle.rawById.get(nodeId);
    const data = raw?.data;

    // 1) Inline data — covers text/image/web/etc. without a disk read.
    const inlineLabel =
      typeof data?.label === 'string' && data.label.trim()
        ? data.label
        : undefined;
    const inlineContent =
      typeof data?.content === 'string' && data.content.trim()
        ? data.content.slice(0, 120)
        : undefined;
    const inlineSrc =
      typeof data?.src === 'string' && data.src.trim() ? data.src : undefined;
    let snippet = inlineLabel ?? inlineContent ?? inlineSrc;

    // 2) Markdown frontmatter ladder — for nodes whose body lives on
    //    disk (note nodes typically). Mirrors `readPreview` in
    //    canvas-spatial so the two surfaces stay consistent.
    if (!snippet) {
      const meta = store.readNode(nodeId);
      if (meta) {
        const summary = (meta as Record<string, unknown>).summary;
        if (typeof summary === 'string' && summary.trim()) {
          snippet = summary.trim();
        } else {
          const keywords = (meta as Record<string, unknown>).keywords;
          if (Array.isArray(keywords)) {
            const kws = keywords.filter(
              (k): k is string => typeof k === 'string' && k.trim().length > 0,
            );
            if (kws.length > 0) snippet = kws.join(', ');
          }
          if (
            !snippet &&
            typeof meta.content === 'string' &&
            meta.content.trim()
          ) {
            snippet = meta.content.slice(0, 120);
          }
        }
      }
    }

    cache.set(nodeId, snippet);
    return snippet;
  };

  return buildNodeNeighbourhoodContext(
    target,
    bundle.spatialNodes,
    bundle.edges,
    getSnippet,
  );
}

// ─── Algorithm types ────────────────────────────────────────────────────────

/** A spatial group of nodes near the anchor. */
export interface SpatialGroup {
  /** X offset (px) from reference center to group centroid. Positive = right. */
  dx: number;
  /** Y offset (px) from reference center to group centroid. Positive = below. */
  dy: number;
  /** Human-readable arrangement description. */
  arrangement: string;
  /**
   * Parent frame ID, if all nodes in this group share the same frame.
   *
   * NOTE: The renderer only consumes `frameLabel`. This field is
   * currently dead weight — safe to drop unless a future caller wants
   * to follow the back-reference (e.g. an `inspect_nodes` tool).
   */
  frameId?: string;
  /** Parent frame label (human-readable). */
  frameLabel?: string;
  /** Nodes in reading order with lightweight metadata. */
  nodes: Array<{
    id: string;
    type?: string;
    label?: string;
    snippet?: string;
  }>;
  /**
   * Minimum edge-to-edge distance (px) from the reference to the
   * closest node in this group. Used internally for filtering and
   * sorting; never read by the renderer.
   * @internal
   */
  _minEdgeDist: number;
}

/**
 * A layer of spatial context.
 * - The innermost layer describes the anchor node vs. siblings in its frame.
 * - Each outer layer describes the parent frame vs. its surroundings.
 */
export interface SpatialLayer {
  /**
   * If this layer is scoped to a frame, its ID.
   *
   * NOTE: The renderer only consumes `frameLabel`. Mirrors the same
   * "currently unused, kept for forward compat" caveat as
   * {@link SpatialGroup.frameId}.
   */
  frameId?: string;
  /** Human-readable frame name (if scoped). */
  frameLabel?: string;
  /** Groups of nodes/entities at this layer, relative to the reference. */
  groups: SpatialGroup[];
}

/** The neighbourhood of a focal ("anchor") node on a canvas. */
export interface NodeNeighbourhoodContext {
  /**
   * Nested layers, from innermost (anchor node within its frame) to
   * outermost (top-level canvas).
   */
  layers: SpatialLayer[];
  /** Edges crossing between groups or touching the anchor node. */
  relevantEdges: Array<{
    source: string;
    target: string;
    sourceLabel?: string;
    targetLabel?: string;
  }>;
}

// ─── Algorithm ──────────────────────────────────────────────────────────────

/**
 * Build the neighbourhood context around any node on a canvas.
 *
 * Uses a nested approach:
 *   1. If the anchor is inside a frame, describe its position relative
 *      to sibling nodes in the same frame.
 *   2. Then describe that frame's position relative to entities
 *      outside it (other frames as wholes, loose nodes).
 *   3. Repeat for grandparent frames if nested.
 */
export function buildNodeNeighbourhoodContext(
  anchorNode: SpatialNode,
  allNodes: SpatialNode[],
  edges: ReadonlyArray<{ source: string; target: string }>,
  getSnippet?: (nodeId: string) => string | undefined,
  opts?: { maxDistance?: number },
): NodeNeighbourhoodContext {
  const nodeById = new Map(allNodes.map((n) => [n.id, n]));
  const maxDistance = opts?.maxDistance ?? 2000;

  // All content nodes (non-frame, non-self).
  const contentNodes = allNodes.filter(
    (n) => n.id !== anchorNode.id && n.type !== 'frame',
  );

  const layers: SpatialLayer[] = [];
  const allGroups: SpatialGroup[] = [];

  // ── Walk from inside-out, starting from the anchor node ──
  let currentRef: SpatialNode = anchorNode;
  let currentFrameId: string | null | undefined = anchorNode.parentId;

  while (true) {
    const frame = currentFrameId ? nodeById.get(currentFrameId) : undefined;

    if (frame) {
      // ── Inner layer: currentRef vs siblings inside this frame ──
      const siblings = contentNodes.filter(
        (n) => n.parentId === currentFrameId && n.id !== currentRef.id,
      );
      const siblingGroups = buildGroupsFromNodes(
        currentRef,
        siblings,
        nodeById,
        getSnippet,
      ).filter((g) => g._minEdgeDist <= maxDistance);
      layers.push({
        frameId: frame.id,
        frameLabel: frame.label,
        groups: siblingGroups,
      });
      allGroups.push(...siblingGroups);

      // Move outward: the frame itself becomes the reference entity.
      currentRef = frame;
      currentFrameId = frame.parentId;
    } else {
      // ── Outermost layer: currentRef vs everything outside ──
      // Collect ancestors to exclude.
      const ancestorIds = new Set<string>();
      {
        let p: string | null | undefined = anchorNode.parentId;
        while (p) {
          ancestorIds.add(p);
          p = nodeById.get(p)?.parentId;
        }
      }

      // Helper: true when any ancestor of `n` is in `ancestorIds`.
      const isInsideAncestor = (n: SpatialNode): boolean => {
        let pid = n.parentId;
        while (pid) {
          if (ancestorIds.has(pid)) return true;
          pid = nodeById.get(pid)?.parentId;
        }
        return false;
      };

      // Top-level content nodes: not the anchor, not an ancestor frame,
      // not a frame, and not nested inside any ancestor frame.
      const topLevelOuter = allNodes.filter(
        (n) =>
          n.id !== anchorNode.id &&
          !ancestorIds.has(n.id) &&
          n.type !== 'frame' &&
          !isInsideAncestor(n),
      );

      // Top-level frames that are NOT ancestors (treated as whole entities).
      const outerFrames = allNodes.filter(
        (n) =>
          n.type === 'frame' &&
          n.id !== anchorNode.id &&
          !ancestorIds.has(n.id) &&
          !isInsideAncestor(n),
      );

      // Build groups from loose nodes (non-frame, no parent that is an outer frame).
      const outerFrameIds = new Set(outerFrames.map((f) => f.id));
      const looseNodes = topLevelOuter.filter((n) => {
        // Not inside any of the outer frames.
        return !n.parentId || !outerFrameIds.has(n.parentId);
      });

      const outerGroups: SpatialGroup[] = [];

      // Each outer frame becomes a single group.
      for (const f of outerFrames) {
        const refC = rectCenter(currentRef.rect);
        const fC = rectCenter(f.rect);
        const childCount = contentNodes.filter(
          (n) => n.parentId === f.id,
        ).length;
        const fEdgeDist = rectEdgeDistance(currentRef.rect, f.rect);
        outerGroups.push({
          dx: Math.round(fC.x - refC.x),
          dy: Math.round(fC.y - refC.y),
          _minEdgeDist: Math.round(fEdgeDist),
          arrangement: `frame with ${childCount} nodes`,
          frameId: f.id,
          frameLabel: f.label,
          nodes: [
            {
              id: f.id,
              type: 'frame',
              label: f.label,
            },
          ],
        });
      }

      // Cluster loose nodes.
      const looseGroups = buildGroupsFromNodes(
        currentRef,
        looseNodes,
        nodeById,
        getSnippet,
      );
      outerGroups.push(...looseGroups);

      // Filter by maxDistance (edge-to-edge) and sort.
      const filteredOuter = outerGroups.filter(
        (g) => g._minEdgeDist <= maxDistance,
      );
      filteredOuter.sort((a, b) => a._minEdgeDist - b._minEdgeDist);

      if (filteredOuter.length > 0) {
        layers.push({ groups: filteredOuter });
        allGroups.push(...filteredOuter);
      }

      break; // outermost layer done
    }
  }

  // If no layers at all, the node is isolated.
  if (layers.length === 0 && allGroups.length === 0) {
    return { layers: [], relevantEdges: [] };
  }

  // Find edges that involve nearby nodes or touch the anchor node.
  const nearbyIds = new Set(allGroups.flatMap((g) => g.nodes.map((n) => n.id)));
  nearbyIds.add(anchorNode.id);

  const relevantEdges = edges
    .filter((e) => nearbyIds.has(e.source) && nearbyIds.has(e.target))
    .map((e) => ({
      source: e.source,
      target: e.target,
      sourceLabel: nodeById.get(e.source)?.label,
      targetLabel: nodeById.get(e.target)?.label,
    }));

  return { layers, relevantEdges };
}

// ─── Algorithm helpers ──────────────────────────────────────────────────────

/** Build SpatialGroups from a flat list of nodes relative to a reference. */
function buildGroupsFromNodes(
  ref: SpatialNode,
  nodes: SpatialNode[],
  nodeById: Map<string, SpatialNode>,
  getSnippet?: (nodeId: string) => string | undefined,
): SpatialGroup[] {
  if (nodes.length === 0) return [];

  const clusterGap = 200;

  // Partition by parentId, then cluster within each partition.
  const byParent = new Map<string, SpatialNode[]>();
  for (const n of nodes) {
    const key = n.parentId ?? '__none__';
    let arr = byParent.get(key);
    if (!arr) {
      arr = [];
      byParent.set(key, arr);
    }
    arr.push(n);
  }

  const groups: SpatialGroup[] = [];
  for (const [key, partition] of byParent) {
    const parentId = key === '__none__' ? null : key;
    const sub = findClusters(partition, clusterGap);
    for (const cluster of sub) {
      const ordered = sortByReadingOrder(cluster);
      const arrangement = detectArrangement(cluster);

      const offset = groupOffset(ref, cluster);
      const edgeDist = minEdgeDistFromCluster(cluster, ref);
      const group: SpatialGroup = {
        dx: offset.dx,
        dy: offset.dy,
        _minEdgeDist: edgeDist,
        arrangement,
        nodes: ordered.map((n) => ({
          id: n.id,
          type: n.type,
          label: n.label,
          snippet: getSnippet?.(n.id),
        })),
      };

      // Only set frame fields when a parent frame exists.
      if (parentId) {
        const frame = nodeById.get(parentId);
        if (frame) {
          group.frameId = parentId;
          group.frameLabel = frame.label;
        }
      }

      groups.push(group);
    }
  }

  // Sort by edge distance to ref.
  groups.sort((a, b) => a._minEdgeDist - b._minEdgeDist);

  return groups;
}

/** Compute dx/dy offset from ref center to group centroid. */
function groupOffset(
  ref: SpatialNode,
  cluster: SpatialNode[],
): { dx: number; dy: number } {
  const refC = rectCenter(ref.rect);
  const sumX = cluster.reduce((s, n) => s + rectCenter(n.rect).x, 0);
  const sumY = cluster.reduce((s, n) => s + rectCenter(n.rect).y, 0);
  return {
    dx: Math.round(sumX / cluster.length - refC.x),
    dy: Math.round(sumY / cluster.length - refC.y),
  };
}

/** Minimum edge-to-edge distance from any node in the cluster to the ref. */
function minEdgeDistFromCluster(
  cluster: SpatialNode[],
  ref: SpatialNode,
): number {
  let min = Infinity;
  for (const n of cluster) {
    const d = rectEdgeDistance(ref.rect, n.rect);
    if (d < min) min = d;
  }
  return Math.round(min);
}

// ─── Renderer: NodeNeighbourhoodContext → Markdown ──────────────────────────

/**
 * Render a {@link NodeNeighbourhoodContext} as a Markdown block. Kept
 * separate from {@link renderNodeNeighbourhoodMarkdown} so it can be
 * reused or unit-tested without touching the canvas store.
 */
function serializeNodeNeighbourhoodContext(
  ctx: NodeNeighbourhoodContext,
): string {
  const sections: string[] = [];

  for (const layer of ctx.layers) {
    const heading = layer.frameLabel
      ? `### Inside "${layer.frameLabel}" frame`
      : '### Canvas Level';
    const groups = layer.groups
      .map((g) => {
        const dir =
          g.dx === 0 && g.dy === 0
            ? 'overlapping'
            : g.dy < -50
              ? 'above'
              : g.dy > 50
                ? 'below'
                : g.dx < 0
                  ? 'to the left'
                  : 'to the right';
        const nodeLines = g.nodes
          .map(
            (n) =>
              `- "${n.label ?? n.id}" [${n.type ?? 'unknown'}]${n.snippet ? ` — ${n.snippet}` : ''}`,
          )
          .join('\n');
        return `**${dir}** (${g.arrangement}):\n${nodeLines}`;
      })
      .join('\n\n');
    sections.push(`${heading}\n\n${groups}`);
  }

  if (ctx.relevantEdges.length > 0) {
    const edgeLines = ctx.relevantEdges
      .map(
        (e) =>
          `- "${e.sourceLabel ?? e.source}" → "${e.targetLabel ?? e.target}"`,
      )
      .join('\n');
    sections.push(`### Connections\n\n${edgeLines}`);
  }

  return sections.join('\n\n');
}
