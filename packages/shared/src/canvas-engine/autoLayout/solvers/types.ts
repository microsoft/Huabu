/**
 * @file CanvasPage solver interface.
 *
 * A solver is the minimal replaceable algorithm unit.
 * It receives the full layout graph (nodes, edges, groups) and returns
 * positions and group sizes. Compound layout, fixed-node constraints,
 * and disconnected-component handling are the solver's responsibility.
 */

import type { LayoutGraph, LayoutOptions, LayoutResult } from '../types.js';

export interface LayoutSolver {
  solve(graph: LayoutGraph, options: LayoutOptions): LayoutResult;
}
