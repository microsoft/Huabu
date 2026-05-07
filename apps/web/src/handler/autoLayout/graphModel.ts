/**
 * @file GraphModel — converts canvas data into a LayoutGraph.
 *
 * Reads canvas nodes + edges and produces a UI-framework-agnostic
 * graph structure for the layout engine. This includes:
 *   a) Node mapping   — CanvasNode → LayoutNode
 *   b) Edge aggregation — user edges + implicit relation edges
 *   c) Group construction — parentId hierarchy → LayoutGroup[]
 */

import { getLayoutNodeSize } from '@/utils/node/size';

import type { LayoutEdge, LayoutGraph, LayoutGroup, LayoutNode } from './types';
import type { Node, Edge } from '@xyflow/react';

// ── Edge weight constants ──────────────────────────────────────────────

const WEIGHT_USER_EDGE = 1.0;
const WEIGHT_ORIGIN_SOURCE_ID = 0.4;
const WEIGHT_SAME_CHAT_THREAD = 0.3;
// Frame siblings must always be in the same connected component so the cola
// solver never packs them into separate sub-graphs and displaces them relative
// to their shared parent frame.
const WEIGHT_SAME_FRAME = 0.2;

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Add or update a virtual edge, keeping max weight per (source, target) pair.
 */
function upsertEdge(
  map: Map<string, LayoutEdge>,
  source: string,
  target: string,
  weight: number,
): void {
  // Normalise direction so (A,B) and (B,A) share the same key
  const key = source < target ? `${source}::${target}` : `${target}::${source}`;
  const existing = map.get(key);
  if (existing) {
    existing.weight = Math.max(existing.weight, weight);
  } else {
    map.set(key, { source, target, weight });
  }
}

// ── Public API ─────────────────────────────────────────────────────────

export interface BuildGraphOptions {
  /** Node IDs to mark as fixed (won't be repositioned). */
  fixedNodeIds?: Set<string>;
  /** Only include nodes within this frame (and its descendants). */
  scopeFrameId?: string;
}

/**
 * Build a `LayoutGraph` from the current canvas state.
 */
export function buildLayoutGraph(
  nodes: Node[],
  edges: Edge[],
  options: BuildGraphOptions = {},
): LayoutGraph {
  const { fixedNodeIds, scopeFrameId } = options;

  // If scoped to a frame, collect all descendant IDs
  let scopeIds: Set<string> | null = null;
  if (scopeFrameId) {
    scopeIds = new Set<string>();
    const collect = (parentId: string) => {
      for (const n of nodes) {
        if (n.parentId === parentId) {
          scopeIds!.add(n.id);
          if (n.type === 'frame') collect(n.id);
        }
      }
    };
    collect(scopeFrameId);
  }

  // 1. Node mapping
  const layoutNodes: LayoutNode[] = [];
  const nodeMap = new Map<string, Node>();

  // Pre-build a set of locked node IDs (any type) and locked frame IDs
  // (whose children also inherit the fixed flag).
  const lockedNodeIds = new Set<string>(
    nodes
      .filter((n) =>
        Boolean((n.data as Record<string, unknown> | undefined)?.locked),
      )
      .map((n) => n.id),
  );
  const lockedFrameIds = new Set<string>(
    nodes
      .filter((n) => n.type === 'frame' && lockedNodeIds.has(n.id))
      .map((n) => n.id),
  );

  for (const n of nodes) {
    if (scopeIds && !scopeIds.has(n.id)) continue;
    // Skip frame nodes when scoped — the frame itself is the container
    if (n.type === 'frame' && n.id === scopeFrameId) continue;

    nodeMap.set(n.id, n);
    const { w, h } = getLayoutNodeSize(n);

    // A node must not be repositioned if:
    //   1. It is in the explicit fixedNodeIds set (incremental / selected layout), OR
    //   2. Its own data.locked = true (any node type), OR
    //   3. Its direct parent is a locked frame (children inherit the lock).
    const isPinned =
      (fixedNodeIds?.has(n.id) ?? false) ||
      lockedNodeIds.has(n.id) ||
      (n.parentId !== null &&
        n.parentId !== undefined &&
        lockedFrameIds.has(n.parentId));

    layoutNodes.push({
      id: n.id,
      width: w,
      height: h,
      position: { ...n.position },
      fixed: isPinned,
    });
  }

  // 2. Edge aggregation
  const edgeMap = new Map<string, LayoutEdge>();

  // 2a. User edges (explicit connections)
  for (const e of edges) {
    if (!nodeMap.has(e.source) || !nodeMap.has(e.target)) continue;
    upsertEdge(edgeMap, e.source, e.target, WEIGHT_USER_EDGE);
  }

  // 2b. origin.excerptFromNodeId (user-excerpt) — link captured node back
  // to the canvas node it was excerpted from.
  for (const n of nodeMap.values()) {
    const data = n.data as Record<string, unknown>;
    const origin = data?.origin as
      | { type?: string; excerptFromNodeId?: string }
      | undefined;
    if (origin?.excerptFromNodeId && nodeMap.has(origin.excerptFromNodeId)) {
      const targetNodeId = origin.excerptFromNodeId;
      if (targetNodeId !== n.id) {
        upsertEdge(edgeMap, n.id, targetNodeId, WEIGHT_ORIGIN_SOURCE_ID);
      }
    }
  }

  // 2c. Same origin.threadId (user-from-chat) — nodes from the same chat
  const nodesByChatThread = new Map<string, string[]>();
  for (const n of nodeMap.values()) {
    const data = n.data as Record<string, unknown>;
    const origin = data?.origin as
      | { type?: string; threadId?: string }
      | undefined;
    if (origin?.type === 'user-from-chat' && origin.threadId) {
      const tid = origin.threadId;
      const arr = nodesByChatThread.get(tid) ?? [];
      arr.push(n.id);
      nodesByChatThread.set(tid, arr);
    }
  }
  for (const group of nodesByChatThread.values()) {
    for (let i = 0; i < group.length - 1; i++) {
      for (let j = i + 1; j < group.length; j++) {
        upsertEdge(edgeMap, group[i], group[j], WEIGHT_SAME_CHAT_THREAD);
      }
    }
  }

  // 2f. Frame siblings — ensure every node inside the same frame is in the
  // same connected component.  Without this, disconnected siblings are laid
  // out by separate cola instances and then packed 400 px apart, causing
  // their parent-relative positions to diverge from the frame's bounds.
  const nodesByFrame = new Map<string, string[]>();
  for (const n of nodeMap.values()) {
    if (!n.parentId) continue;
    const arr = nodesByFrame.get(n.parentId) ?? [];
    arr.push(n.id);
    nodesByFrame.set(n.parentId, arr);
  }
  for (const siblings of nodesByFrame.values()) {
    // Fully-connect all siblings so stress majorization targets equal
    // pairwise distances, producing a cluster rather than a chain.
    for (let i = 0; i < siblings.length - 1; i++) {
      for (let j = i + 1; j < siblings.length; j++) {
        upsertEdge(edgeMap, siblings[i], siblings[j], WEIGHT_SAME_FRAME);
      }
    }
  }

  // 3. Group construction from parentId
  const groupMap = new Map<string, LayoutGroup>();
  for (const n of nodes) {
    if (n.type !== 'frame') continue;
    if (scopeIds && !scopeIds.has(n.id)) continue;
    if (n.id === scopeFrameId) continue;

    const children = nodes
      .filter((c) => c.parentId === n.id)
      .filter((c) => !scopeIds || scopeIds.has(c.id))
      .map((c) => c.id);

    if (children.length > 0) {
      groupMap.set(n.id, {
        id: n.id,
        children,
      });
    }
  }

  const layoutGraph: LayoutGraph = {
    nodes: layoutNodes,
    edges: Array.from(edgeMap.values()),
    groups: Array.from(groupMap.values()),
  };

  return layoutGraph;
}
