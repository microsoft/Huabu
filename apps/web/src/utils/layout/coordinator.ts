/**
 * @file LayoutCoordinator — the single external entry point for all layout operations.
 *
 * Orchestrates: GraphModel → LayoutEngine → PositionApplier.
 *
 * Consumed by canvas store actions and UI components.
 */

import { applyLayoutResult } from './applier';
import { LayoutEngine } from './engine';
import { buildLayoutGraph } from './graphModel';
import { DEFAULT_LAYOUT_OPTIONS } from './types';

import type { LayoutOptions } from './types';
import type { Node, Edge } from '@xyflow/react';

// Singleton engine instance — solver can be swapped here.
const engine = new LayoutEngine();

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Full re-layout of all nodes.
 * Returns new nodes array or null if no changes.
 */
export function layoutAll(
  nodes: Node[],
  edges: Edge[],
  options?: Partial<LayoutOptions>,
): Node[] | null {
  const graph = buildLayoutGraph(nodes, edges);
  const result = engine.layout(graph, options);
  return applyLayoutResult(nodes, edges, result);
}

/**
 * Full re-layout within a specific frame only.
 * Returns new nodes array or null if no changes.
 */
export function layoutGroup(
  nodes: Node[],
  edges: Edge[],
  frameId: string,
  options?: Partial<LayoutOptions>,
): Node[] | null {
  const graph = buildLayoutGraph(nodes, edges, { scopeFrameId: frameId });
  const result = engine.layout(graph, options);
  return applyLayoutResult(nodes, edges, result);
}

/**
 * Incremental placement of a single new node.
 * All existing nodes stay fixed — only the target node is positioned.
 * Returns new nodes array or null if no changes.
 */
export function placeNode(
  nodes: Node[],
  edges: Edge[],
  nodeId: string,
  options?: Partial<LayoutOptions>,
): Node[] | null {
  const fixedNodeIds = new Set(
    nodes.filter((n) => n.id !== nodeId).map((n) => n.id),
  );

  // If the node is inside a frame, scope to that frame
  const targetNode = nodes.find((n) => n.id === nodeId);
  const scopeFrameId = targetNode?.parentId ?? undefined;

  const graph = buildLayoutGraph(nodes, edges, { fixedNodeIds, scopeFrameId });
  const result = engine.place(graph, options);
  return applyLayoutResult(nodes, edges, result);
}

/**
 * Auto-arrange only the selected nodes.
 * Non-selected nodes remain in place.
 * Returns new nodes array or null if no changes.
 */
export function layoutSelected(
  nodes: Node[],
  edges: Edge[],
  selectedIds: string[],
  options?: Partial<LayoutOptions>,
): Node[] | null {
  if (selectedIds.length < 2) return null;

  const selectedSet = new Set(selectedIds);
  const fixedNodeIds = new Set(
    nodes.filter((n) => !selectedSet.has(n.id)).map((n) => n.id),
  );

  const graph = buildLayoutGraph(nodes, edges, { fixedNodeIds });
  const result = engine.layout(graph, options);
  return applyLayoutResult(nodes, edges, result);
}

export { DEFAULT_LAYOUT_OPTIONS };
export type { LayoutOptions };
