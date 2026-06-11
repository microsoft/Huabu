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
 *
 * The concrete solvers are **not** imported at module load. Both
 * `colaSolver` and `fcoseSolver` transitively pull in
 * `cytoscape-layout-utilities`, which reads `window` at module-load
 * time and crashes any Node-only host (server, vitest --environment
 * node, headless executor, etc.). Instead the web host calls
 * `registerLayoutSolvers({...})` once at boot (see `./web.ts`); on
 * the server the defaults stay `null` and `layout()` / `place()`
 * return an empty `LayoutResult`, which the coordinator treats as a
 * no-op.
 */

import type { LayoutSolver } from './solvers/types.js';
import type { LayoutGraph, LayoutOptions, LayoutResult } from './types.js';

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  nodeSpacing: 10,
  componentSpacing: 300,
  framePadding: 5,
  nodePadding: 5,
};

// Returned when no solver is registered (e.g. headless / server). The
// downstream `applyLayoutResult` treats an empty result as "nothing to
// do" and returns the input nodes unchanged.
const EMPTY_LAYOUT_RESULT: LayoutResult = {
  positions: new Map(),
  groupSizes: new Map(),
};

let defaultLayoutSolver: LayoutSolver | null = null;
let defaultPlaceSolver: LayoutSolver | null = null;

/**
 * Register the default solvers used by every `LayoutEngine` instance.
 * Intended to be called exactly once during app startup on hosts that
 * want auto-layout (currently: the web client via
 * `@sediment/shared/canvas-engine/web`).
 */
export function registerLayoutSolvers(solvers: {
  layout?: LayoutSolver;
  place?: LayoutSolver;
}): void {
  if (solvers.layout) defaultLayoutSolver = solvers.layout;
  if (solvers.place) defaultPlaceSolver = solvers.place;
}

// ── CanvasPage Engine ──────────────────────────────────────────────────────

export class LayoutEngine {
  private layoutSolverOverride: LayoutSolver | null;
  private placeSolverOverride: LayoutSolver | null;

  constructor(layoutSolver?: LayoutSolver, placeSolver?: LayoutSolver) {
    this.layoutSolverOverride = layoutSolver ?? null;
    this.placeSolverOverride = placeSolver ?? null;
  }

  /**
   * Full layout — repositions all non-fixed nodes.
   * Compound nodes (frames / groups) are handled natively by the solver.
   */
  layout(
    graph: LayoutGraph,
    options: Partial<LayoutOptions> = {},
  ): LayoutResult {
    const solver = this.layoutSolverOverride ?? defaultLayoutSolver;
    if (!solver) return EMPTY_LAYOUT_RESULT;
    const opts = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
    return solver.solve(graph, opts);
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
    const solver = this.placeSolverOverride ?? defaultPlaceSolver;
    if (!solver) return EMPTY_LAYOUT_RESULT;
    const opts = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
    return solver.solve(graph, opts);
  }
}
