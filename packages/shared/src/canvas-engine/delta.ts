// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canvas state deltas — the wire-friendly diff between two canvas states.
 *
 * A `Delta` describes one atomic structural change (a node/edge was
 * inserted, removed, or replaced). The executor on the server runs a
 * batch of {@link CanvasCommand}s against the prior state, then diffs
 * prestate → poststate via {@link diffCanvasState} to produce the
 * coarse delta list that travels back to clients.
 *
 * Phase A (M2) intentionally uses **coarse** deltas: any in-place edit
 * to a node or edge becomes a `REPLACE_NODE` / `REPLACE_EDGE` carrying
 * the full prior and next objects. Fine-grained per-property deltas
 * (e.g. `SET_NODE_POSITION { dx, dy }`) are a future-M5 refinement —
 * the executor and persistence format already accommodate them because
 * `applyDeltas` discriminates on `type`.
 *
 * Inversion is exact: applying `invertDelta(d)` to a state that has
 * `d` applied returns the original state, so a delta-log row paired
 * with its inverse forms an undo / replay primitive without re-running
 * the command engine.
 *
 * Pure functions only — no host or network coupling.
 */

import type { CanvasEdge, CanvasNode } from './interfaces.js';

/**
 * Per-id structural change between two canvas states.
 *
 * Discriminated union keyed on `type`. Self-inverting via
 * {@link invertDelta} — inverses share the same field shape, with
 * `prev` and `next` swapped (for `REPLACE_*`) or `INSERT_*` / `DELETE_*`
 * roles flipped.
 */
export type Delta =
  | { type: 'INSERT_NODE'; node: CanvasNode }
  | { type: 'DELETE_NODE'; node: CanvasNode }
  | { type: 'REPLACE_NODE'; prev: CanvasNode; next: CanvasNode }
  | { type: 'INSERT_EDGE'; edge: CanvasEdge }
  | { type: 'DELETE_EDGE'; edge: CanvasEdge }
  | { type: 'REPLACE_EDGE'; prev: CanvasEdge; next: CanvasEdge };

/**
 * Return the inverse of a single delta. Applying the inverse to a
 * state that already has the delta applied yields the original state.
 */
export function invertDelta(delta: Delta): Delta {
  switch (delta.type) {
    case 'INSERT_NODE':
      return { type: 'DELETE_NODE', node: delta.node };
    case 'DELETE_NODE':
      return { type: 'INSERT_NODE', node: delta.node };
    case 'REPLACE_NODE':
      return { type: 'REPLACE_NODE', prev: delta.next, next: delta.prev };
    case 'INSERT_EDGE':
      return { type: 'DELETE_EDGE', edge: delta.edge };
    case 'DELETE_EDGE':
      return { type: 'INSERT_EDGE', edge: delta.edge };
    case 'REPLACE_EDGE':
      return { type: 'REPLACE_EDGE', prev: delta.next, next: delta.prev };
  }
}

/**
 * Apply a delta list to a `{ nodes, edges }` snapshot, producing the
 * next snapshot. Pure — does not mutate the input arrays or their
 * elements.
 *
 * Unknown ids in `REPLACE_*` / `DELETE_*` are tolerated: missing-target
 * deltas are skipped. This matches the relaxed semantics needed for
 * out-of-order broadcast delivery in M3 — the executor on the server
 * is still the single source of truth for what state the log row
 * landed against.
 */
export function applyDeltas(
  state: { nodes: readonly CanvasNode[]; edges: readonly CanvasEdge[] },
  deltas: readonly Delta[],
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  // Work in mutable copies indexed by id for O(1) lookup; rebuild
  // ordered arrays at the end so any pure consumers (React, server
  // diff) see a stable element order.
  const nodeMap = new Map<string, CanvasNode>(
    state.nodes.map((n) => [n.id, n]),
  );
  const edgeMap = new Map<string, CanvasEdge>(
    state.edges.map((e) => [e.id, e]),
  );

  for (const delta of deltas) {
    switch (delta.type) {
      case 'INSERT_NODE':
        nodeMap.set(delta.node.id, delta.node);
        break;
      case 'DELETE_NODE':
        nodeMap.delete(delta.node.id);
        break;
      case 'REPLACE_NODE':
        // Only commit when the target still exists; otherwise the
        // delta references a node that was already removed by a
        // concurrent operation and we silently skip.
        if (nodeMap.has(delta.next.id)) {
          nodeMap.set(delta.next.id, delta.next);
        }
        break;
      case 'INSERT_EDGE':
        edgeMap.set(delta.edge.id, delta.edge);
        break;
      case 'DELETE_EDGE':
        edgeMap.delete(delta.edge.id);
        break;
      case 'REPLACE_EDGE':
        if (edgeMap.has(delta.next.id)) {
          edgeMap.set(delta.next.id, delta.next);
        }
        break;
    }
  }

  return {
    nodes: Array.from(nodeMap.values()),
    edges: Array.from(edgeMap.values()),
  };
}
