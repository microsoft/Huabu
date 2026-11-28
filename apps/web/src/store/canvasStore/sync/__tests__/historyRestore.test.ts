// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { restoreChanged } from '../historyRestore';
import { edgeKey, EXISTENCE_UNIT, nodeUnitKey } from '../inFlight';

import type { UnitNode } from '../propertyUnits';

type N = UnitNode & { position?: { x: number; y: number } };
const node = (id: string, x: number, extra: Partial<N> = {}): N => ({
  id,
  position: { x, y: 0 },
  data: { style: { accent: 'white' } },
  ...extra,
});
/** A node carrying its paint key, as every node a page loads does. */
const keyed = (id: string, paintKey: string, extra: Partial<N> = {}): N =>
  node(id, 0, { ...extra, data: { paintKey } });
const PAINT_UNIT = 'data.paintKey';
const ids = (nodes: readonly UnitNode[]) => nodes.map((n) => n.id);

describe('restoreChanged', () => {
  it('puts back only the units the local edit changed', () => {
    const snapshot = { nodes: [node('x', 0), node('y', 0)], edges: [] };
    const current = {
      nodes: [
        // Moved here, recoloured by another page since.
        node('x', 500, { data: { style: { accent: 'blue' } }, selected: true }),
        // Moved by another page since.
        node('y', 900),
      ],
      edges: [],
    };
    const result = restoreChanged(
      current,
      snapshot,
      new Set([nodeUnitKey('x', 'position')]),
    );
    expect(result.nodes[0]).toMatchObject({
      position: { x: 0, y: 0 },
      data: { style: { accent: 'blue' } },
      selected: true,
    });
    expect(result.nodes[1]).toBe(current.nodes[1]);
  });

  it('removes what the edit created and brings back what it deleted', () => {
    const edge = { id: 'e', source: 'x', target: 'gone' };
    const snapshot = {
      nodes: [node('x', 0), node('gone', 0)],
      edges: [edge],
    };
    const current = {
      nodes: [node('x', 0), node('made', 0), node('remote', 0)],
      edges: [{ id: 'e2', source: 'x', target: 'made' }],
    };
    const result = restoreChanged(
      current,
      snapshot,
      new Set([
        nodeUnitKey('made', EXISTENCE_UNIT),
        nodeUnitKey('gone', EXISTENCE_UNIT),
        edgeKey('e'),
      ]),
    );
    // The other page's node stays; the edge to the removed node goes.
    expect(ids(result.nodes)).toEqual(['x', 'remote', 'gone']);
    expect(result.edges).toEqual([edge]);
  });

  it("restores a node's place in the order around nodes the snapshot does not know", () => {
    const snapshot = {
      nodes: [keyed('a', 'a0'), keyed('b', 'a1'), keyed('c', 'a2')],
      edges: [],
    };
    // This page sent `c` to the back; another page added `new` since,
    // between `a` and `b`.
    const current = {
      nodes: [
        keyed('c', 'Zz'),
        keyed('a', 'a0'),
        keyed('new', 'a0V'),
        keyed('b', 'a1'),
      ],
      edges: [],
    };
    const result = restoreChanged(
      current,
      snapshot,
      new Set([nodeUnitKey('c', PAINT_UNIT)]),
    );
    expect(ids(result.nodes)).toEqual(['a', 'new', 'b', 'c']);
    expect(
      result.nodes.map((n) => (n.data as { paintKey?: string }).paintKey),
    ).toEqual(['a0', 'a0V', 'a1', 'a2']);
  });

  it("restores only the node it names, not another page's later reorder of a sibling", () => {
    const snapshot = {
      nodes: [keyed('a', 'a0'), keyed('b', 'a1'), keyed('c', 'a2')],
      edges: [],
    };
    // This page brought `a` to the front; another page then sent `c` to
    // the back.
    const current = {
      nodes: [keyed('c', 'Zz'), keyed('b', 'a1'), keyed('a', 'a3')],
      edges: [],
    };
    const result = restoreChanged(
      current,
      snapshot,
      new Set([nodeUnitKey('a', PAINT_UNIT)]),
    );
    expect(ids(result.nodes)).toEqual(['c', 'a', 'b']);
  });

  it("reorders one parent without moving another parent's children", () => {
    const child = (id: string, parentId: string, paintKey: string) =>
      keyed(id, paintKey, { parentId });
    const snapshot = {
      nodes: [
        keyed('f', 'a0'),
        keyed('g', 'a1'),
        child('a', 'f', 'a0'),
        child('b', 'f', 'a1'),
        child('p', 'g', 'a0'),
        child('q', 'g', 'a1'),
      ],
      edges: [],
    };
    // Both parents' children were swapped since; only `a` is this page's.
    const current = {
      nodes: [
        keyed('f', 'a0'),
        child('b', 'f', 'a1'),
        child('a', 'f', 'a2'),
        keyed('g', 'a1'),
        child('q', 'g', 'a1'),
        child('p', 'g', 'a2'),
      ],
      edges: [],
    };
    const result = restoreChanged(
      current,
      snapshot,
      new Set([nodeUnitKey('a', PAINT_UNIT)]),
    );
    // Each parent is followed by its own children, in key order.
    expect(ids(result.nodes)).toEqual(['f', 'a', 'b', 'g', 'q', 'p']);
  });

  it('does not restore a node into a parent another page removed', () => {
    const snapshot = {
      nodes: [node('f', 0), node('x', 10, { parentId: 'f' })],
      edges: [],
    };
    const current = { nodes: [node('x', 300)], edges: [] };
    const result = restoreChanged(
      current,
      snapshot,
      new Set([nodeUnitKey('x', 'parent'), nodeUnitKey('x', 'position')]),
    );
    expect(result.nodes[0].parentId).toBeUndefined();
    // The old position was relative to that parent; it is not restored either.
    expect(result.nodes[0].position).toEqual({ x: 300, y: 0 });
  });

  it('ignores a unit of a node that no longer exists', () => {
    const snapshot = { nodes: [node('x', 0)], edges: [] };
    const current = { nodes: [node('y', 5)], edges: [] };
    const result = restoreChanged(
      current,
      snapshot,
      new Set([nodeUnitKey('x', 'position')]),
    );
    expect(result.nodes).toEqual(current.nodes);
  });
});
