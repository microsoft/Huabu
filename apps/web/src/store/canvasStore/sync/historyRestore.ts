// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Restoring part of an undo snapshot.
 *
 * A snapshot is the whole Space as it was before one local edit. When
 * another page has changed the Space since, putting the whole snapshot back
 * would undo that page's edits as well. `restoreChanged` puts back only
 * what the local edit changed — the in-flight keys recorded for it — and
 * leaves everything else as it is now.
 *
 * Pure functions only.
 */

import { EXISTENCE_UNIT, parseKey } from './inFlight';
import {
  applyUnits,
  PARENT_UNIT,
  POSITION_UNIT,
  readUnit,
  writeUnit,
  type UnitNode,
} from './propertyUnits';

type RestoreEdge = { id: string; source: string; target: string } & Record<
  string,
  unknown
>;

interface RestoreState<N extends UnitNode, E extends RestoreEdge> {
  nodes: readonly N[];
  edges: readonly E[];
}

export function restoreChanged<N extends UnitNode, E extends RestoreEdge>(
  current: RestoreState<N, E>,
  snapshot: RestoreState<N, E>,
  changed: ReadonlySet<string>,
): { nodes: N[]; edges: E[] } {
  const then = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const nodes = new Map(current.nodes.map((node) => [node.id, node]));
  const order = current.nodes.map((node) => node.id);
  const edges = new Map(current.edges.map((edge) => [edge.id, edge]));
  const thenEdges = new Map(snapshot.edges.map((edge) => [edge.id, edge]));
  const reordered: Array<string | null> = [];

  for (const key of changed) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    if (parsed.kind === 'edge') {
      const edge = thenEdges.get(parsed.edgeId);
      if (edge) edges.set(edge.id, edge);
      else edges.delete(parsed.edgeId);
      continue;
    }
    if (parsed.kind === 'order') {
      reordered.push(parsed.parentId);
      continue;
    }
    const { nodeId, unit } = parsed;
    const before = then.get(nodeId);
    if (unit === EXISTENCE_UNIT) {
      if (before && !nodes.has(nodeId)) {
        nodes.set(nodeId, before);
        order.push(nodeId);
      } else if (!before && nodes.has(nodeId)) {
        nodes.delete(nodeId);
        order.splice(order.indexOf(nodeId), 1);
      }
      continue;
    }
    const live = nodes.get(nodeId);
    if (!before || !live) continue;
    nodes.set(nodeId, writeUnit(live, unit, readUnit(before, unit)));
  }

  // A parent another page removed meanwhile cannot be restored into; the
  // position that went with it is relative to that parent, so both stay.
  for (const [id, node] of nodes) {
    const parentId = node.parentId as string | undefined;
    if (parentId && !nodes.has(parentId)) {
      const live = current.nodes.find((candidate) => candidate.id === id) ?? {
        id,
      };
      nodes.set(id, applyUnits(node, live, [PARENT_UNIT, POSITION_UNIT]));
    }
  }

  // Sibling order: put each restored parent's children back in the
  // snapshot's order, in the slots they occupy now; children the snapshot
  // does not know keep their place after them.
  let ordered = order;
  for (const parentId of reordered) {
    const isChild = (id: string): boolean =>
      ((nodes.get(id)?.parentId as string | undefined) ?? null) === parentId;
    const wanted = snapshot.nodes
      .map((node) => node.id)
      .filter((id) => nodes.has(id) && isChild(id));
    const wantedSet = new Set(wanted);
    const present = ordered.filter(isChild);
    const sequence = [...wanted, ...present.filter((id) => !wantedSet.has(id))];
    let next = 0;
    ordered = ordered.map((id) => (isChild(id) ? sequence[next++] : id));
  }

  for (const [id, edge] of edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) edges.delete(id);
  }

  return {
    nodes: ordered.flatMap((id) => {
      const node = nodes.get(id);
      return node ? [node] : [];
    }),
    edges: [...edges.values()],
  };
}
