/**
 * @file Layout solver interface.
 *
 * A solver is the minimal replaceable algorithm unit.
 * It receives a flat list of nodes + edges and returns new positions.
 * No group/hierarchy awareness — that is handled by the engine layer.
 */

import type { LayoutNode, LayoutEdge, LayoutOptions } from '../types';

export interface LayoutSolver {
  solve(
    nodes: LayoutNode[],
    edges: LayoutEdge[],
    options: LayoutOptions,
  ): Map<string, { x: number; y: number }>;
}
