// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { restoreChanged } from '../historyRestore';
import { edgeKey, EXISTENCE_UNIT, nodeUnitKey, orderKey } from '../inFlight';

import type { UnitNode } from '../propertyUnits';

type N = UnitNode & { position?: { x: number; y: number } };
const node = (id: string, x: number, extra: Partial<N> = {}): N => ({
  id,
  position: { x, y: 0 },
  data: { style: { accent: 'white' } },
  ...extra,
});
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

  it('restores sibling order around nodes the snapshot does not know', () => {
    const snapshot = {
      nodes: [node('a', 0), node('b', 0), node('c', 0)],
      edges: [],
    };
    const current = {
      nodes: [node('c', 0), node('a', 0), node('new', 0), node('b', 0)],
      edges: [],
    };
    const result = restoreChanged(current, snapshot, new Set([orderKey(null)]));
    expect(ids(result.nodes)).toEqual(['a', 'b', 'c', 'new']);
  });

  it("reorders one parent without moving another parent's children", () => {
    const child = (id: string, parentId: string) => node(id, 0, { parentId });
    const snapshot = {
      nodes: [
        node('f', 0),
        node('g', 0),
        child('a', 'f'),
        child('b', 'f'),
        child('p', 'g'),
        child('q', 'g'),
      ],
      edges: [],
    };
    const current = {
      nodes: [
        node('f', 0),
        node('g', 0),
        child('b', 'f'),
        child('q', 'g'),
        child('a', 'f'),
        child('p', 'g'),
      ],
      edges: [],
    };
    const result = restoreChanged(current, snapshot, new Set([orderKey('f')]));
    expect(ids(result.nodes)).toEqual(['f', 'g', 'a', 'q', 'b', 'p']);
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
