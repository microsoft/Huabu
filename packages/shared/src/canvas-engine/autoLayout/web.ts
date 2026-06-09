/**
 * @file Web-only auto-layout setup.
 *
 * Importing this file eagerly loads `cytoscape`, `cytoscape-fcose`, and
 * `cytoscape-layout-utilities` (the last reads `window` at module-load
 * time, so importing it in Node throws `ReferenceError: window is not
 * defined`).
 *
 * The web client must call `setupWebLayoutSolvers()` exactly once at
 * startup — see `apps/web/src/main.tsx`. Server / headless executors
 * intentionally never reach this module, so `engine.LayoutEngine` falls
 * back to its no-op default and `placeNode` becomes a pass-through.
 */

import { registerLayoutSolvers } from './engine.js';
import { colaSolver } from './solvers/colaSolver.js';
import { fcoseSolver } from './solvers/fcoseSolver.js';

let registered = false;

export function setupWebLayoutSolvers(): void {
  if (registered) return;
  registerLayoutSolvers({ layout: colaSolver, place: fcoseSolver });
  registered = true;
}
