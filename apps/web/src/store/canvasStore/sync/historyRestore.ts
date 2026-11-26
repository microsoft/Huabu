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

import {
  orderByPaintKeys,
  type NestableNode,
} from '@huabu/shared/canvas-engine';

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

  for (const key of changed) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    if (parsed.kind === 'edge') {
      const edge = thenEdges.get(parsed.edgeId);
      if (edge) edges.set(edge.id, edge);
      else edges.delete(parsed.edgeId);
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

  for (const [id, edge] of edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) edges.delete(id);
  }

  return {
    // Paint order is each node's own `data.paintKey`, restored above like
    // any other unit; the array follows the keys. The store would order it
    // on the way in, but the restore plan reads this array's order first.
    nodes: orderByPaintKeys(
      order.flatMap((id) => {
        const node = nodes.get(id);
        return node ? [node] : [];
      }) as unknown as NestableNode[],
    ) as unknown as N[],
    edges: [...edges.values()],
  };
}
