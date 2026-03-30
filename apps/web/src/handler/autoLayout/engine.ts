/**
 * @file LayoutEngine — delegates layout to the configured solver(s).
 *
 * Uses different solvers for different operations:
 * - **layout()** (full re-layout) → WebCola (stress majorization).
 *   All nodes are free, so Cola can optimise globally without conflicts.
 * - **place()** (incremental single-node placement) → fCoSE.
 *   fCoSE uses hard `fixedNodeConstraint` pins, so fixed nodes stay
 *   perfectly still and the new node is positioned via force simulation
 *   without contradictory all-pairs-shortest-path stress.
 */

import { colaSolver } from './solvers/colaSolver';
import { fcoseSolver } from './solvers/fcoseSolver';

import type { LayoutSolver } from './solvers/types';
import type { LayoutGraph, LayoutOptions, LayoutResult } from './types';

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  nodeSpacing: 10,
  componentSpacing: 300,
  framePadding: 5,
  nodePadding: 5,
};

// ── Layout Engine ──────────────────────────────────────────────────────

export class LayoutEngine {
  private layoutSolver: LayoutSolver;
  private placeSolver: LayoutSolver;

  constructor(layoutSolver?: LayoutSolver, placeSolver?: LayoutSolver) {
    this.layoutSolver = layoutSolver ?? colaSolver;
    this.placeSolver = placeSolver ?? fcoseSolver;
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
    return this.layoutSolver.solve(graph, opts);
  }

  /**
   * Incremental placement — only positions nodes marked fixed=false.
   * Uses fCoSE by default for hard fixed-node constraints that avoid
   * the stress-matrix conflicts inherent in stress-majorization solvers.
   */
  place(
    graph: LayoutGraph,
    options: Partial<LayoutOptions> = {},
  ): LayoutResult {
    const opts = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
    return this.placeSolver.solve(graph, opts);
  }
}
