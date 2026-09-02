// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
 *      `buildSpatialBundle`, owns the preview-extraction policy
 *      (label > content[:120] > src), and feeds the algorithm.
 *   3. Renderer — `serializeNodeNeighbourhood(ctx)`
 *      serialises the structured context into the XML block that sits
 *      inside `<canvas_neighbourhood>`. Both backends address a node by
 *      its `file=` path, so the two stay in lock-step the same way
 *      `<selected_nodes>` does.
 *
 * Originally driven by question nodes (`useQuestionRunner` ships the
 * question node id as the anchor), but anchor-type agnostic.
 *
 * Lives outside `packages/shared` because nothing on the web bundle
 * currently consumes it. Sits next to `canvas-spatial.ts` (its
 * geometry dependency) rather than next to its sole consumer
 * (`agent/agent.route.ts`) so the spatial layer stays self-contained.
 */

import {
  detectArrangement,
  findClusters,
  rectCenter,
  rectEdgeDistance,
  sortByReadingOrder,
} from '@huabu/shared';

import { buildSpatialBundle } from './canvas-spatial.js';
import { describeNode } from './node-prompt.js';
import {
  escapeXmlAttr,
  renderNodes,
} from '../agent/conversation/prompt/node-element.js';
import { buildAgentNodePreview } from '../agent/node-ref.js';
import { space } from '../storage/index.js';

import type { AgentNodePreview } from '../agent/node-ref.js';
import type { CanvasNodeType, SpatialNode } from '@huabu/shared';

const DEFAULT_NEIGHBOURHOOD_RADIUS = 400;

// ─── Public entry point ─────────────────────────────────────────────────────

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
 * Owns the preview-extraction policy. Forwards each node through the
 * shared {@link extractAgentNodePreview} ladder
 * (`summary > content[:120] > src`) with two inputs merged in one
 * pass: the stored node record (canonical for note nodes whose body lives
 * outside the topology) and the inline `data.content` / `data.src`
 * (text-on-canvas nodes whose body is never a separate record).
 *
 * Records are read once, up front, for the whole Space. The neighbourhood
 * is a subset, so this reads more than the old lazy per-node path did on a
 * sparse canvas — but a lazy read cannot cross an async port without making
 * the pure walk below async too, and the walk already visits every node to
 * build the spatial bundle (§12.6.1).
 */
export async function getNodeNeighbourhood(
  canvasId: string,
  anchorNodeId: string,
): Promise<NodeNeighbourhoodContext | null> {
  const handle = space(canvasId);
  const canvas = await handle.read();
  if (!canvas) return null;
  const bundle = buildSpatialBundle(canvas);
  const target = bundle.spatialNodes.find((n) => n.id === anchorNodeId);
  if (!target) return null;

  const records = await handle.nodes.list();
  // One assembler for every neighbour: the node carries whatever the spatial
  // bundle knows (id / type; its `data.label` is always empty), and
  // `describeNode` fills label + body from the record, then derives the
  // `file=` path, preview line, and `rev` token (in lock-step with the RFS
  // `ETag`).
  const describe = (n: SpatialNode): AgentNodePreview =>
    describeNode(
      { id: n.id, type: n.type, ...(n.label ? { label: n.label } : {}) },
      'preview',
      records.get(n.id)?.record ?? null,
    );

  return buildNodeNeighbourhoodContext(
    target,
    bundle.spatialNodes,
    bundle.edges,
    describe,
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
  /**
   * Nodes in reading order, each shaped as the unified L1
   * {@link AgentNodePreview}: identity + pre-computed `filename` so
   * the agent can `read` straight away, plus the `preview` line
   * picked by the shared `extractAgentNodePreview` ladder.
   */
  nodes: AgentNodePreview[];
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
  describe?: (node: SpatialNode) => AgentNodePreview,
  opts?: { maxDistance?: number },
): NodeNeighbourhoodContext {
  const nodeById = new Map(allNodes.map((n) => [n.id, n]));
  const maxDistance = opts?.maxDistance ?? DEFAULT_NEIGHBOURHOOD_RADIUS;
  const connectedIds = new Set<string>();
  for (const edge of edges) {
    if (edge.source === anchorNode.id) connectedIds.add(edge.target);
    if (edge.target === anchorNode.id) connectedIds.add(edge.source);
  }

  // All content nodes (non-frame, non-self).
  const contentNodes = allNodes.filter(
    (n) => n.id !== anchorNode.id && n.type !== 'frame',
  );

  const layers: SpatialLayer[] = [];
  const allGroups: SpatialGroup[] = [];

  // ── Walk from inside-out, starting from the anchor node ──
  let currentRef: SpatialNode = anchorNode;
  let currentFrameId: string | null | undefined = anchorNode.parentId;
  let isAnchorFrame = true;

  while (true) {
    const frame = currentFrameId ? nodeById.get(currentFrameId) : undefined;

    if (frame) {
      // ── Inner layer: currentRef vs siblings inside this frame ──
      const siblingCandidates = isAnchorFrame ? allNodes : contentNodes;
      const siblings = siblingCandidates.filter(
        (n) => n.parentId === currentFrameId && n.id !== currentRef.id,
      );
      const siblingGroups = buildGroupsFromNodes(
        currentRef,
        siblings,
        nodeById,
        describe,
      ).filter((g) => isAnchorFrame || g._minEdgeDist <= maxDistance);

      if (isAnchorFrame) {
        const frameCenter = rectCenter(frame.rect);
        const refCenter = rectCenter(currentRef.rect);
        siblingGroups.unshift({
          dx: Math.round(frameCenter.x - refCenter.x),
          dy: Math.round(frameCenter.y - refCenter.y),
          _minEdgeDist: 0,
          arrangement: 'containing frame',
          frameId: frame.id,
          frameLabel: frame.label,
          nodes: [
            describe?.(frame) ??
              buildAgentNodePreview({
                id: frame.id,
                type: 'frame' as CanvasNodeType,
                ...(frame.label ? { label: frame.label } : {}),
              }),
          ],
        });
      }
      layers.push({
        frameId: frame.id,
        frameLabel: frame.label,
        groups: siblingGroups,
      });
      allGroups.push(...siblingGroups);

      // Move outward: the frame itself becomes the reference entity.
      currentRef = frame;
      currentFrameId = frame.parentId;
      isAnchorFrame = false;
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
            describe?.(f) ??
              buildAgentNodePreview({
                id: f.id,
                type: 'frame' as CanvasNodeType,
                ...(f.label ? { label: f.label } : {}),
              }),
          ],
        });
      }

      // Cluster loose nodes.
      const looseGroups = buildGroupsFromNodes(
        currentRef,
        looseNodes,
        nodeById,
        describe,
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

  // Explicit relationships outrank proximity. A connected endpoint may sit
  // beyond the radius or inside an outer frame whose descendants are normally
  // represented only by that frame, so append any endpoint not already shown.
  const includedIds = new Set(
    allGroups.flatMap((group) => group.nodes.map((node) => node.id)),
  );
  const missingConnectedNodes = [...connectedIds]
    .map((id) => nodeById.get(id))
    .filter(
      (node): node is SpatialNode =>
        node !== undefined && !includedIds.has(node.id),
    );
  if (missingConnectedNodes.length > 0) {
    const connectedGroups = buildGroupsFromNodes(
      anchorNode,
      missingConnectedNodes,
      nodeById,
      describe,
    );
    layers.push({ groups: connectedGroups });
    allGroups.push(...connectedGroups);
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
  describe?: (node: SpatialNode) => AgentNodePreview,
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
        nodes: ordered.map(
          (n) =>
            describe?.(n) ??
            buildAgentNodePreview({
              id: n.id,
              type: (n.type ?? 'note') as CanvasNodeType,
              ...(n.label ? { label: n.label } : {}),
            }),
        ),
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

// ─── Renderer: NodeNeighbourhoodContext → XML ───────────────────────────────

/**
 * Serialize a {@link NodeNeighbourhoodContext} into the XML body that
 * sits inside `<canvas_neighbourhood>`. Each spatial group becomes a
 * `<group>` element carrying its `direction` / `arrangement` / `frame`
 * as attributes and wrapping the same `<node>` elements
 * {@link renderNodes} emits for `<selected_nodes>` — so a
 * neighbourhood node is addressable (id + `file` + `preview`)
 * exactly like a selected one, instead of an un-actionable bullet line.
 * Cross-group edges are listed under `<connections>` as `<edge>`
 * elements (both endpoints carry the node id plus a `*-label` hint).
 *
 * Both backends address a node by its `file=` path (the built-in agent
 * `read()`s it; the external/ACP agent downloads it over the RFS), so the
 * two serialize the SAME structured context identically.
 *
 * Kept separate from {@link getNodeNeighbourhood} so it can be
 * unit-tested without touching the canvas store.
 */
export function serializeNodeNeighbourhood(
  ctx: NodeNeighbourhoodContext,
): string {
  const blocks: string[] = [];

  for (const layer of ctx.layers) {
    for (const g of layer.groups) {
      const direction =
        g.dx === 0 && g.dy === 0
          ? 'overlapping'
          : g.dy < -50
            ? 'above'
            : g.dy > 50
              ? 'below'
              : g.dx < 0
                ? 'to the left'
                : 'to the right';
      // A group's own frame wins over the layer's; either disambiguates
      // which frame the cluster sits in when the canvas nests them.
      const frame = g.frameLabel ?? layer.frameLabel;
      const attrs = [
        `direction="${escapeXmlAttr(direction)}"`,
        `arrangement="${escapeXmlAttr(g.arrangement)}"`,
        frame ? `frame="${escapeXmlAttr(frame)}"` : '',
      ]
        .filter(Boolean)
        .join(' ');
      blocks.push(
        [`<group ${attrs}>`, renderNodes(g.nodes), '</group>'].join('\n'),
      );
    }
  }

  if (ctx.relevantEdges.length > 0) {
    const edges = ctx.relevantEdges
      .map((e) => {
        const a = [
          `from="${escapeXmlAttr(e.source)}"`,
          e.sourceLabel ? `from-label="${escapeXmlAttr(e.sourceLabel)}"` : '',
          `to="${escapeXmlAttr(e.target)}"`,
          e.targetLabel ? `to-label="${escapeXmlAttr(e.targetLabel)}"` : '',
        ]
          .filter(Boolean)
          .join(' ');
        return `<edge ${a} />`;
      })
      .join('\n');
    blocks.push(['<connections>', edges, '</connections>'].join('\n'));
  }

  return blocks.join('\n');
}
