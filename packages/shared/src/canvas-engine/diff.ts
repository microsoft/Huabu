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
 * Entity semantics:
 *
 *   - Identity equality (`Object.is`) on `node` / `edge` references is
 *     the fast path. The engine handlers return shared references for
 *     untouched items, so most batches emit zero deltas for the
 *     untouched majority and one REPLACE per actually-mutated id.
 *
 *   - When node references differ, the row carries only the fields that
 *     differ, with their previous and new values (`nodeFieldChanges`): a
 *     moved node's row holds its position, not its body. A deleted node's
 *     row holds the whole node here, so the caller can still build the
 *     insert that reverts it; `toWireDeltas` reduces it to an id before
 *     the row travels. Edges are small and are carried whole.
 *
 * Pure — does not depend on host or executor state.
 */

import {
  nodeFieldChanges,
  TRANSIENT_NODE_FIELDS,
  type Delta,
} from './delta.js';

export { TRANSIENT_NODE_FIELDS };

import type { CanvasEdge, CanvasNode } from './interfaces.js';

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
 * Compute the entity deltas that turn `prev` into `next`.
 *
 * Paint order needs no row of its own: it is the node field
 * `data.paintKey`, so a reorder is a `REPLACE_NODE` of the moved node.
 *
 * Output ordering: deletes first, then inserts, then replaces.
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
    // Only the fields that differ; runtime UI fields never count.
    const changes = nodeFieldChanges(prevNode, nextNode);
    if (changes) {
      out.push({
        type: 'REPLACE_NODE',
        ...changes,
        ...(nextNode.type !== undefined ? { nodeType: nextNode.type } : {}),
        ...(prevNode.hidden && nextNode.hidden
          ? { hidden: true as const }
          : {}),
      });
    }
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
