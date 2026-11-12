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
 * Legacy execution uses **coarse** deltas: any in-place edit
 * to a node or edge becomes a `REPLACE_NODE` / `REPLACE_EDGE` carrying
 * the full prior and next objects. Fine-grained per-property deltas
 * (e.g. `SET_NODE_POSITION { dx, dy }`) are a future-M5 refinement —
 * the executor and persistence format already accommodate them because
 * `applyDeltas` discriminates on `type`.
 *
 * Legacy deltas do not encode sibling order. Ordered batches add complete
 * sibling lists and must be replayed/inverted as a whole, never row by row.
 *
 * Pure functions only — no host or network coupling.
 */

import {
  applySiblingOrderEvents,
  SiblingOrderReplayError,
  type SetSiblingOrderEvent,
} from './siblingOrder.js';

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

/** Opt-in until hosts can consume atomic order batches rather than filtered rows. */
export type OrderedDelta = Delta | SetSiblingOrderEvent;

/**
 * Invert one row. Membership/order restoration requires the complete inverted
 * batch. Retained orderVersion describes the recorded effect, not a live undo.
 */
export function invertDelta<T extends OrderedDelta>(
  delta: T,
): T extends Delta ? Delta : SetSiblingOrderEvent;
export function invertDelta(delta: OrderedDelta): OrderedDelta {
  switch (delta.type) {
    case 'SET_SIBLING_ORDER':
      return { ...delta, before: delta.after, after: delta.before };
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
 * Legacy entity-only input tolerates missing replacements/deletes. Input with
 * an order event uses strict atomic replay instead. New-protocol callers must
 * use applyOrderedDeltas even when a batch contains no order event.
 */
export function applyDeltas(
  state: { nodes: readonly CanvasNode[]; edges: readonly CanvasEdge[] },
  deltas: readonly OrderedDelta[],
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  if (deltas.some((delta) => delta.type === 'SET_SIBLING_ORDER')) {
    return applyOrderedDeltas(state, deltas);
  }
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

/**
 * Replay one complete ordered batch against its exact baseline. Throws before
 * publishing any result on missing entities/lists, stale order or invalid trees.
 * This is isolated replay, not concurrent undo or draft reconciliation.
 */
export function applyOrderedDeltas(
  state: { nodes: readonly CanvasNode[]; edges: readonly CanvasEdge[] },
  deltas: readonly OrderedDelta[],
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const nodeIds = new Set(state.nodes.map((node) => node.id));
  const edgeIds = new Set(state.edges.map((edge) => edge.id));
  if (edgeIds.size !== state.edges.length) {
    throw new SiblingOrderReplayError('Duplicate edge IDs');
  }
  const entities: Delta[] = [];
  const orders: SetSiblingOrderEvent[] = [];
  for (const delta of deltas) {
    if (delta.type === 'SET_SIBLING_ORDER') {
      orders.push(delta);
      continue;
    }
    const isNode = delta.type.endsWith('_NODE');
    const ids = isNode ? nodeIds : edgeIds;
    const entity =
      'node' in delta ? delta.node : 'edge' in delta ? delta.edge : delta.next;
    if (delta.type.startsWith('INSERT_')) {
      if (ids.has(entity.id)) {
        throw new SiblingOrderReplayError(`Duplicate insert: ${entity.id}`);
      }
      ids.add(entity.id);
    } else {
      if (
        !ids.has(entity.id) ||
        ('prev' in delta && delta.prev.id !== entity.id)
      ) {
        throw new SiblingOrderReplayError(
          `Missing or mismatched entity: ${entity.id}`,
        );
      }
      if (delta.type.startsWith('DELETE_')) ids.delete(entity.id);
    }
    entities.push(delta);
  }
  const result = applyDeltas(state, entities);
  result.nodes = applySiblingOrderEvents(state.nodes, result.nodes, orders);
  for (const edge of result.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new SiblingOrderReplayError(`Missing edge endpoint: ${edge.id}`);
    }
  }
  return result;
}
