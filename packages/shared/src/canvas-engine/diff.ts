// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Coarse diff between two canvas state snapshots.
 *
 * Used by the headless executor (apps/server/src/modules/canvas/canvas-executor.ts)
 * to derive the {@link Delta} list that travels over the wire to clients
 * after a server-side batch run. The executor produces a poststate;
 * this module reduces (prestate, poststate) → coarse deltas.
 *
 * Phase A semantics (matches `delta.ts` Phase A note):
 *
 *   - Identity equality (`Object.is`) on `node` / `edge` references is
 *     the fast path. The engine handlers return shared references for
 *     untouched items, so most batches emit zero deltas for the
 *     untouched majority and one REPLACE per actually-mutated id.
 *
 *   - When references differ, the entire next object becomes a
 *     `REPLACE_*` payload — there is no per-property minimisation.
 *     Wire size stays small because a typical agent batch touches
 *     few nodes; large batches that move many nodes will produce
 *     proportional payloads, which is acceptable for Phase A.
 *
 * Pure — does not depend on host or executor state.
 */

import type { Delta } from './delta.js';
import type { CanvasEdge, CanvasNode } from './interfaces.js';

/**
 * Top-level React Flow runtime fields — selection / drag / measurement
 * bookkeeping the renderer writes onto every node or edge. They are NOT
 * authored content and MUST be ignored when deciding whether a node or
 * edge actually changed: otherwise a pure selection flip (e.g. creating
 * a node auto-selects it and deselects the user's node) would diff into
 * a spurious REPLACE and surface as a phantom "Updated" change.
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

/** React Flow runtime fields on edges (selection only). */
export const TRANSIENT_EDGE_FIELDS = ['selected'] as const;

/** Return a shallow copy of `node` with runtime UI fields removed. */
export function stripTransientNodeFields<T extends object>(node: T): T {
  const out = { ...node } as Record<string, unknown>;
  for (const k of TRANSIENT_NODE_FIELDS) delete out[k];
  return out as T;
}

/** Return a shallow copy of `edge` with runtime UI fields removed. */
export function stripTransientEdgeFields<T extends object>(edge: T): T {
  const out = { ...edge } as Record<string, unknown>;
  for (const k of TRANSIENT_EDGE_FIELDS) delete out[k];
  return out as T;
}

/**
 * Compute the coarse delta list that transforms `prev` into `next`.
 *
 * Output ordering: deletes first, then inserts, then replaces. This
 * lets {@link applyDeltas} consumers reason about transient state
 * (e.g. delete an old edge that referenced a node, before that node
 * is replaced) without juggling intermediate maps.
 */
export function diffCanvasState(
  prev: { nodes: readonly CanvasNode[]; edges: readonly CanvasEdge[] },
  next: { nodes: readonly CanvasNode[]; edges: readonly CanvasEdge[] },
): Delta[] {
  const out: Delta[] = [];

  const prevNodeMap = new Map<string, CanvasNode>(
    prev.nodes.map((n) => [n.id, n]),
  );
  const nextNodeMap = new Map<string, CanvasNode>(
    next.nodes.map((n) => [n.id, n]),
  );

  // Deletes
  for (const [id, node] of prevNodeMap) {
    if (!nextNodeMap.has(id)) out.push({ type: 'DELETE_NODE', node });
  }

  // Inserts
  for (const [id, node] of nextNodeMap) {
    if (!prevNodeMap.has(id)) out.push({ type: 'INSERT_NODE', node });
  }

  // Replaces (id present in both; reference differs OR shallow equal differs)
  for (const [id, nextNode] of nextNodeMap) {
    const prevNode = prevNodeMap.get(id);
    if (!prevNode) continue;
    if (Object.is(prevNode, nextNode)) continue;
    if (nodesEqual(prevNode, nextNode)) continue;
    out.push({ type: 'REPLACE_NODE', prev: prevNode, next: nextNode });
  }

  const prevEdgeMap = new Map<string, CanvasEdge>(
    prev.edges.map((e) => [e.id, e]),
  );
  const nextEdgeMap = new Map<string, CanvasEdge>(
    next.edges.map((e) => [e.id, e]),
  );

  for (const [id, edge] of prevEdgeMap) {
    if (!nextEdgeMap.has(id)) out.push({ type: 'DELETE_EDGE', edge });
  }
  for (const [id, edge] of nextEdgeMap) {
    if (!prevEdgeMap.has(id)) out.push({ type: 'INSERT_EDGE', edge });
  }
  for (const [id, nextEdge] of nextEdgeMap) {
    const prevEdge = prevEdgeMap.get(id);
    if (!prevEdge) continue;
    if (Object.is(prevEdge, nextEdge)) continue;
    if (edgesEqual(prevEdge, nextEdge)) continue;
    out.push({ type: 'REPLACE_EDGE', prev: prevEdge, next: nextEdge });
  }

  return out;
}

// ── Equality helpers ─────────────────────────────────────────────────────
//
// JSON-stringify is the simplest deep-equal that handles the union of
// shapes we actually emit (CanvasNode/CanvasEdge are plain JSON-able
// records — no functions, no symbols, no Dates). Per-node payloads are
// small (<2KB typical) so this is faster than a generic deep-equal
// library; for the unusually large frame node it stays well under one
// millisecond.

function nodesEqual(a: CanvasNode, b: CanvasNode): boolean {
  // Cheap pre-checks before falling through to stringify.
  if (a.id !== b.id) return false;
  if (a.type !== b.type) return false;
  if (a.parentId !== b.parentId) return false;
  if (a.position?.x !== b.position?.x) return false;
  if (a.position?.y !== b.position?.y) return false;
  // Ignore React Flow runtime UI fields (selected / dragging / measured /
  // resizing) so a pure selection flip never diffs into a REPLACE.
  return (
    safeStringify(stripTransientNodeFields(a)) ===
    safeStringify(stripTransientNodeFields(b))
  );
}

function edgesEqual(a: CanvasEdge, b: CanvasEdge): boolean {
  if (a.id !== b.id) return false;
  if (a.source !== b.source) return false;
  if (a.target !== b.target) return false;
  if (a.sourceHandle !== b.sourceHandle) return false;
  if (a.targetHandle !== b.targetHandle) return false;
  return (
    safeStringify(stripTransientEdgeFields(a)) ===
    safeStringify(stripTransientEdgeFields(b))
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    // Cyclic refs should never appear on canvas nodes; fall back to a
    // sentinel that forces inequality so the caller still emits a
    // REPLACE_* and the wire payload remains correct.
    return Math.random().toString(36);
  }
}
