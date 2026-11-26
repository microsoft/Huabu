// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canvas state deltas — the wire-friendly diff between two canvas states.
 *
 * A `Delta` describes one structural change (a node/edge was inserted,
 * removed, or changed). The executor on the server runs commands against the
 * prior state, then diffs prestate → poststate via {@link diffCanvasState}.
 *
 * **A node row carries only what changed.** `REPLACE_NODE` names the node
 * and holds, in `prev` and `next`, just the fields that differ — top-level
 * fields whole, `data` key by key — with their previous and new values. A
 * field present on one side only was added or removed. Unchanged fields, in
 * particular a body the batch did not touch, are not carried. A row is
 * applied by merging it into the node as it is now ({@link mergeNodeFields},
 * the one applier), never by replacing the node.
 *
 * Rows written before this format carried the whole previous and next node.
 * They are valid input of the same applier: every field they name is set, a
 * field only `prev` names is removed, and a field neither names is kept.
 * {@link slimDelta} reduces such a row to the fields that differ.
 *
 * `INSERT_NODE` carries the node. `DELETE_NODE` needs only the id to be
 * applied; a row that still holds the whole node (as diffed, or kept in a
 * Review record) can be inverted into the insert that brings it back.
 * Edges are small and travel whole.
 *
 * Paint order is a node field (`data.paintKey`), so it travels in a node's
 * row like any other field; {@link applyDeltas} returns the nodes in that
 * order.
 *
 * Pure functions only — no host or network coupling.
 */

import { orderByPaintKeys } from './container/paintOrder.js';

import type { CanvasEdge, CanvasNode } from './interfaces.js';

/**
 * Top-level React Flow runtime fields — selection / drag / measurement
 * bookkeeping the renderer writes onto every node. They are NOT authored
 * content and MUST be ignored when deciding whether a node actually changed:
 * otherwise a pure selection flip (e.g. creating a node auto-selects it and
 * deselects the user's node) would diff into a spurious REPLACE and surface
 * as a phantom "Updated" change.
 *
 * This is the single canonical list, reused by the web undo snapshotter
 * (`createSnapshot`) so both layers strip exactly the same fields.
 */
export const TRANSIENT_NODE_FIELDS = [
  'selected',
  'dragging',
  'measured',
  'resizing',
] as const;

/**
 * A node's id with only the fields a row is about. `data`, when present,
 * holds only the keys concerned.
 */
export type NodeFields = Pick<CanvasNode, 'id'> &
  Partial<Omit<CanvasNode, 'id' | 'data'>> & {
    data?: Record<string, unknown>;
  };

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
  | { type: 'DELETE_NODE'; node: NodeFields }
  | {
      type: 'REPLACE_NODE';
      prev: NodeFields;
      next: NodeFields;
      /**
       * The node's type after the change. Stated on the row because a type
       * that did not change is in neither side; a reader that needs it (is
       * this node sidecar-backed, is it an Agent Node) has no node to ask.
       */
      nodeType?: string;
      /**
       * The node is hidden before and after the change (a Note a PDF owns),
       * for the same reason.
       */
      hidden?: true;
    }
  | { type: 'INSERT_EDGE'; edge: CanvasEdge }
  | { type: 'DELETE_EDGE'; edge: CanvasEdge }
  | { type: 'REPLACE_EDGE'; prev: CanvasEdge; next: CanvasEdge };

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    // Cyclic values never appear on canvas nodes; report them as changed.
    return false;
  }
}

const SKIPPED_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'data',
  ...TRANSIENT_NODE_FIELDS,
]);

/**
 * The fields in which `next` differs from `prev`, as the two sides of a
 * `REPLACE_NODE` row, or `null` when nothing authored differs. Runtime
 * fields ({@link TRANSIENT_NODE_FIELDS}) are never part of it. Given the two
 * sides of a row it returns the same row without the fields that are equal.
 */
export function nodeFieldChanges(
  prev: NodeFields,
  next: NodeFields,
): { prev: NodeFields; next: NodeFields } | null {
  const before: Record<string, unknown> = { id: next.id };
  const after: Record<string, unknown> = { id: next.id };
  let changed = false;
  const from = prev as Record<string, unknown>;
  const to = next as Record<string, unknown>;
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (SKIPPED_FIELDS.has(key)) continue;
    if (sameValue(from[key], to[key])) continue;
    changed = true;
    if (from[key] !== undefined) before[key] = from[key];
    if (to[key] !== undefined) after[key] = to[key];
  }
  const fromData = prev.data ?? {};
  const toData = next.data ?? {};
  const beforeData: Record<string, unknown> = {};
  const afterData: Record<string, unknown> = {};
  let dataChanged = false;
  for (const key of new Set([
    ...Object.keys(fromData),
    ...Object.keys(toData),
  ])) {
    if (sameValue(fromData[key], toData[key])) continue;
    dataChanged = true;
    if (fromData[key] !== undefined) beforeData[key] = fromData[key];
    if (toData[key] !== undefined) afterData[key] = toData[key];
  }
  if (dataChanged) {
    before['data'] = beforeData;
    after['data'] = afterData;
  }
  if (!changed && !dataChanged) return null;
  return { prev: before as NodeFields, next: after as NodeFields };
}

/**
 * Apply one `REPLACE_NODE` row to the node as it is now: every field either
 * side names takes `next`'s value, or is removed when `next` does not have
 * it; everything else stays. The single applier of a node change — server
 * replay, Review revert and preview, and the page's update path all go
 * through it.
 */
export function mergeNodeFields(
  current: CanvasNode,
  prev: NodeFields,
  next: NodeFields,
): CanvasNode {
  const out: Record<string, unknown> = { ...current };
  const to = next as Record<string, unknown>;
  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (key === 'id' || key === 'data') continue;
    if (to[key] === undefined) delete out[key];
    else out[key] = to[key];
  }
  if (prev.data !== undefined || next.data !== undefined) {
    const data: Record<string, unknown> = { ...(current.data ?? {}) };
    const toData = next.data ?? {};
    for (const key of new Set([
      ...Object.keys(prev.data ?? {}),
      ...Object.keys(toData),
    ])) {
      if (toData[key] === undefined) delete data[key];
      else data[key] = toData[key];
    }
    out['data'] = data;
  }
  return out as CanvasNode;
}

/** The type of the node a `REPLACE_NODE` row is about, after the change. */
export function replacedNodeType(
  delta: Extract<Delta, { type: 'REPLACE_NODE' }>,
): string | undefined {
  return delta.next.type ?? delta.nodeType ?? delta.prev.type;
}

/** Whether `fields` is a whole node rather than the part a row is about. */
export function isWholeNode(fields: NodeFields): fields is CanvasNode {
  return (
    fields.position !== undefined &&
    fields.data !== undefined &&
    typeof fields.data === 'object'
  );
}

/**
 * Reduce a row to what it changes: a `REPLACE_NODE` keeps only the fields
 * that differ (`null` when none does). Other rows are returned as they are.
 */
export function slimDelta(delta: Delta): Delta | null {
  if (delta.type !== 'REPLACE_NODE') return delta;
  const changes = nodeFieldChanges(delta.prev, delta.next);
  if (!changes) return null;
  const hidden =
    delta.hidden ?? (delta.prev.hidden === true && delta.next.hidden === true);
  const nodeType = replacedNodeType(delta);
  return {
    type: 'REPLACE_NODE',
    ...changes,
    ...(nodeType !== undefined ? { nodeType } : {}),
    ...(hidden ? { hidden: true as const } : {}),
  };
}

/** {@link slimDelta} over a list, dropping rows that change nothing. */
export function slimDeltas(deltas: readonly Delta[]): Delta[] {
  return deltas.flatMap((delta) => {
    const slim = slimDelta(delta);
    return slim ? [slim] : [];
  });
}

/**
 * The rows as they travel and are journalled: minimal replaces, and a
 * deletion reduced to the node's id, type and hidden flag. What is needed to bring a
 * deleted node back is kept where a revert is possible at all — the Review
 * record of the batch — not sent to every page.
 */
export function toWireDeltas(deltas: readonly Delta[]): Delta[] {
  return slimDeltas(deltas).map((delta) =>
    delta.type === 'DELETE_NODE'
      ? {
          type: 'DELETE_NODE',
          node: {
            id: delta.node.id,
            ...(delta.node.type !== undefined ? { type: delta.node.type } : {}),
            ...(delta.node.hidden ? { hidden: true } : {}),
          },
        }
      : delta,
  );
}

/** Replay recorded field changes without replacing later unrelated values. */
export function replayChangedData(
  current: Record<string, unknown>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...current };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    if (Object.prototype.hasOwnProperty.call(after, key))
      result[key] = after[key];
    else delete result[key];
  }
  return result;
}

/**
 * Invert one row. A `DELETE_NODE` reduced to an id ({@link toWireDeltas})
 * cannot be inverted and throws.
 */
export function invertDelta(delta: Delta): Delta {
  switch (delta.type) {
    case 'INSERT_NODE':
      return { type: 'DELETE_NODE', node: delta.node };
    case 'DELETE_NODE':
      // Only a row that still holds the whole node can bring it back.
      if (!isWholeNode(delta.node)) {
        throw new Error(
          `Cannot invert the deletion of ${delta.node.id}: the row does not hold the node`,
        );
      }
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
 * A `REPLACE_NODE` is merged into the current node ({@link mergeNodeFields}).
 * A replacement or deletion of a node that is not there is skipped.
 *
 * The returned nodes are in paint order by the keys they carry
 * (`orderByPaintKeys`): a moved node's row changes its `data.paintKey`, and
 * the array follows. Parent-before-child is the caller's `normalizeTreeOrder`.
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
        {
          const current = nodeMap.get(delta.next.id);
          if (current) {
            nodeMap.set(
              current.id,
              mergeNodeFields(current, delta.prev, delta.next),
            );
          }
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
    nodes: orderByPaintKeys(Array.from(nodeMap.values())),
    edges: Array.from(edgeMap.values()),
  };
}
