/**
 * @file LayoutEngine — delegates layout to the configured solver.
 *
 * With fCoSE the solver handles compound nodes, fixed-node constraints,
 * and disconnected components natively, so the engine is a thin wrapper
 * that merges default options and forwards to the solver.
 */

import { colaSolver } from './solvers/colaSolver';

import type { LayoutSolver } from './solvers/types';
import type { LayoutGraph, LayoutOptions, LayoutResult } from './types';

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  nodeSpacing: 10,
  groupSpacing: 160,
  groupPadding: 40,
};

// ── Layout Engine ──────────────────────────────────────────────────────

export class LayoutEngine {
  private solver: LayoutSolver;

  constructor(solver?: LayoutSolver) {
    this.solver = solver ?? colaSolver;
  }

  /**
   * Full layout — repositions all non-fixed nodes.
   * Compound nodes (frames / groups) are handled natively by the solver.
   */
  layout(
    graph: LayoutGraph,
    options: Partial<LayoutOptions> = {},
  ): LayoutResult {
    const opts = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
    return this.solver.solve(graph, opts);
  }

  /**
   * Incremental placement — only positions nodes marked fixed=false.
   * Fixed nodes are preserved at their current positions via solver constraints.
   */
  place(
    graph: LayoutGraph,
    options: Partial<LayoutOptions> = {},
  ): LayoutResult {
    const opts = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
    return this.solver.solve(graph, opts);
  }
}
