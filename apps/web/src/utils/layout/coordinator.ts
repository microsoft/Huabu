/**
 * @file LayoutCoordinator — the single external entry point for all layout operations.
 *
 * Orchestrates: GraphModel → LayoutEngine → PositionApplier.
 *
 * Consumed by canvas store actions and UI components.
 */

import { applyLayoutResult } from './applier';
import { DEFAULT_LAYOUT_OPTIONS, LayoutEngine } from './engine';
import { buildLayoutGraph } from './graphModel';

import type { ApplyOptions } from './applier';
import type { LayoutOptions } from './types';
import type { Node, Edge } from '@xyflow/react';

type CoordinatorOptions = Partial<LayoutOptions> & ApplyOptions;

// Singleton engine instance.
// layout() uses Cola (stress majorization — great for full re-layout).
// place()  uses fCoSE (hard fixedNodeConstraint — ideal for incremental placement).
const engine = new LayoutEngine();

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Full re-layout of all nodes.
 * Returns new nodes array or null if no changes.
 */
export function layoutAll(
  nodes: Node[],
  edges: Edge[],
  options?: CoordinatorOptions,
): Node[] | null {
  const graph = buildLayoutGraph(nodes, edges);
  const result = engine.layout(graph, options);
  return applyLayoutResult(nodes, edges, result, { animate: options?.animate });
}

/**
 * Full re-layout within a specific frame only.
 * Returns new nodes array or null if no changes.
 */
export function layoutGroup(
  nodes: Node[],
  edges: Edge[],
  frameId: string,
  options?: CoordinatorOptions,
): Node[] | null {
  const graph = buildLayoutGraph(nodes, edges, { scopeFrameId: frameId });
  const result = engine.layout(graph, options);
  return applyLayoutResult(nodes, edges, result, { animate: options?.animate });
}

/**
 * Incremental placement of a single new node.
 * All existing nodes stay fixed — only the target node is positioned.
 *
 * Uses fCoSE (via engine.place) which pins fixed nodes with hard
 * constraints, avoiding the stress-matrix distance conflicts that
 * plague stress-majorization solvers when most nodes are locked.
 *
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

  // Use larger nodeSpacing for incremental placement so fCoSE keeps
  // more breathing room around the new node and avoids overlaps with
  // existing fixed nodes.  The default (20) is too tight when the free
  // node must squeeze into an occupied area.
  const placeOptions: Partial<LayoutOptions> = {
    nodeSpacing: 40,
    ...options,
  };

  const result = engine.place(graph, placeOptions);
  return applyLayoutResult(nodes, edges, result);
}

export { DEFAULT_LAYOUT_OPTIONS };
export type { LayoutOptions };
