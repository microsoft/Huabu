/**
 * @file GraphModel — converts canvas data into a LayoutGraph.
 *
 * Reads canvas nodes + edges and produces a UI-framework-agnostic
 * graph structure for the layout engine. This includes:
 *   a) Node mapping   — CanvasNode → LayoutNode
 *   b) Edge aggregation — user edges + implicit relation edges
 *   c) Group construction — parentId hierarchy → LayoutGroup[]
 */

import type { LayoutEdge, LayoutGraph, LayoutGroup, LayoutNode } from './types';
import type { Node, Edge } from '@xyflow/react';

// ── Edge weight constants ──────────────────────────────────────────────

const WEIGHT_USER_EDGE = 1.0;
const WEIGHT_RELATED_NODE_IDS = 0.6;
const WEIGHT_ORIGIN_SOURCE_ID = 0.4;
const WEIGHT_SAME_RESEARCH_THREAD = 0.3;
const WEIGHT_SAME_CHAT_THREAD = 0.3;

// ── Helpers ────────────────────────────────────────────────────────────

/** Return the computed width/height of a canvas node. */
function getNodeSize(n: Node): { w: number; h: number } {
  const style = n.style as { width?: number; height?: number } | undefined;
  return {
    w:
      typeof style?.width === 'number'
        ? style.width
        : (n.measured?.width ?? 200),
    h:
      typeof style?.height === 'number'
        ? style.height
        : (n.measured?.height ?? 100),
  };
}

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

  for (const n of nodes) {
    if (scopeIds && !scopeIds.has(n.id)) continue;
    // Skip frame nodes when scoped — the frame itself is the container
    if (n.type === 'frame' && n.id === scopeFrameId) continue;

    nodeMap.set(n.id, n);
    const { w, h } = getNodeSize(n);
    layoutNodes.push({
      id: n.id,
      width: w,
      height: h,
      position: { ...n.position },
      fixed: fixedNodeIds?.has(n.id) ?? false,
    });
  }

  // 2. Edge aggregation
  const edgeMap = new Map<string, LayoutEdge>();

  // 2a. User edges (explicit connections)
  for (const e of edges) {
    if (!nodeMap.has(e.source) || !nodeMap.has(e.target)) continue;
    upsertEdge(edgeMap, e.source, e.target, WEIGHT_USER_EDGE);
  }

  // 2b. research.relatedNodeIds — synthesis cites sources
  for (const n of nodeMap.values()) {
    const data = n.data as Record<string, unknown>;
    const research = data?.research as
      | { relatedNodeIds?: string[] }
      | undefined;
    if (research?.relatedNodeIds) {
      for (const relatedId of research.relatedNodeIds) {
        if (nodeMap.has(relatedId)) {
          upsertEdge(edgeMap, n.id, relatedId, WEIGHT_RELATED_NODE_IDS);
        }
      }
    }
  }

  // 2c. origin.sourceId (user-drag-capture) — link captured node to its source
  // origin.sourceId is a knowledge-base source ID (data.sourceId), not a canvas
  // node ID, so we build a reverse lookup from data.sourceId → canvas node ID.
  const nodeByDataSourceId = new Map<string, string>();
  for (const n of nodeMap.values()) {
    const sid = (n.data as Record<string, unknown>)?.sourceId;
    if (typeof sid === 'string') {
      nodeByDataSourceId.set(sid, n.id);
    }
  }
  for (const n of nodeMap.values()) {
    const data = n.data as Record<string, unknown>;
    const origin = data?.origin as
      | { type?: string; sourceId?: string }
      | undefined;
    if (origin?.sourceId) {
      const targetNodeId = nodeByDataSourceId.get(origin.sourceId);
      if (targetNodeId && targetNodeId !== n.id) {
        upsertEdge(edgeMap, n.id, targetNodeId, WEIGHT_ORIGIN_SOURCE_ID);
      }
    }
  }

  // 2d. Same research.threadId — nodes from the same research session
  const nodesByResearchThread = new Map<string, string[]>();
  for (const n of nodeMap.values()) {
    const data = n.data as Record<string, unknown>;
    const research = data?.research as { threadId?: string } | undefined;
    if (research?.threadId) {
      const tid = research.threadId;
      const arr = nodesByResearchThread.get(tid) ?? [];
      arr.push(n.id);
      nodesByResearchThread.set(tid, arr);
    }
  }
  for (const group of nodesByResearchThread.values()) {
    // Chain rather than fully-connect to keep edge count linear
    for (let i = 0; i < group.length - 1; i++) {
      upsertEdge(edgeMap, group[i], group[i + 1], WEIGHT_SAME_RESEARCH_THREAD);
    }
  }

  // 2e. Same origin.threadId (user-drag-chat) — nodes from the same chat
  const nodesByChatThread = new Map<string, string[]>();
  for (const n of nodeMap.values()) {
    const data = n.data as Record<string, unknown>;
    const origin = data?.origin as
      | { type?: string; threadId?: string }
      | undefined;
    if (origin?.type === 'user-drag-chat' && origin.threadId) {
      const tid = origin.threadId;
      const arr = nodesByChatThread.get(tid) ?? [];
      arr.push(n.id);
      nodesByChatThread.set(tid, arr);
    }
  }
  for (const group of nodesByChatThread.values()) {
    for (let i = 0; i < group.length - 1; i++) {
      upsertEdge(edgeMap, group[i], group[i + 1], WEIGHT_SAME_CHAT_THREAD);
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
        padding: 40,
      });
    }
  }

  const layoutGraph: LayoutGraph = {
    nodes: layoutNodes,
    edges: Array.from(edgeMap.values()),
    groups: Array.from(groupMap.values()),
  };

  // Debug: log graph before layout
  console.groupCollapsed(
    `[Layout] buildLayoutGraph — ${layoutGraph.nodes.length} nodes, ${layoutGraph.edges.length} edges, ${layoutGraph.groups.length} groups`,
  );
  console.log('Nodes:');
  for (const n of layoutGraph.nodes) {
    const flags = [n.fixed ? 'fixed' : 'free'];
    const reactFlowNode = nodeMap.get(n.id);
    if (reactFlowNode?.parentId) flags.push(`parent=${reactFlowNode.parentId}`);
    console.log(
      `  ${n.id}  ${n.width}×${n.height}  pos=(${Math.round(n.position.x)},${Math.round(n.position.y)})  [${flags.join(', ')}]`,
    );
  }
  if (layoutGraph.edges.length > 0) {
    console.log('Edges:');
    for (const e of layoutGraph.edges) {
      const label =
        e.weight === 1.0
          ? 'user-edge'
          : e.weight === 0.6
            ? 'relatedNodeIds'
            : e.weight === 0.4
              ? 'origin-sourceId'
              : e.weight === 0.3
                ? 'same-thread'
                : `w=${e.weight}`;
      console.log(`  ${e.source} ↔ ${e.target}  (${label})`);
    }
  } else {
    console.log('  (no edges)');
  }
  console.groupEnd();

  return layoutGraph;
}
