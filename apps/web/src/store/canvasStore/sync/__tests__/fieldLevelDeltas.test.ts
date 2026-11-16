// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { applyDeltas, type Delta } from '@huabu/shared/canvas-engine';

import { toFieldLevelDeltas } from '../fieldLevelDeltas';
import { edgeKey, EXISTENCE_UNIT, nodeUnitKey } from '../inFlight';

import type { UnitNode } from '../propertyUnits';

type Node = UnitNode & {
  position: { x: number; y: number };
  data: Record<string, unknown>;
};

const serverX: Node = {
  id: 'x',
  type: 'note',
  position: { x: 0, y: 0 },
  data: { label: 'X', style: { accent: 'white' } },
};
const y: Node = { id: 'y', type: 'note', position: { x: 0, y: 200 }, data: {} };

const replace = (prev: Node, next: Node): Delta =>
  ({ type: 'REPLACE_NODE', prev, next }) as unknown as Delta;
const held =
  (...keys: string[]) =>
  (key: string) =>
    keys.includes(key);
const apply = (nodes: Node[], deltas: Delta[]): Node[] =>
  applyDeltas({ nodes: nodes as never, edges: [] }, deltas)
    .nodes as unknown as Node[];

describe('toFieldLevelDeltas', () => {
  it('reproduces the server node when nothing is held and the local node is unchanged', () => {
    const next = {
      ...serverX,
      position: { x: 40, y: 0 },
      data: { label: 'X', style: { accent: 'blue' } },
    };
    const result = toFieldLevelDeltas({
      deltas: [replace(serverX, next)],
      localNodes: [serverX, y],
      localEdges: [],
      isHeld: () => false,
    });
    expect(apply([serverX, y], result.deltas)).toEqual([next, y]);
    expect(result.withheld).toEqual([]);
  });

  it('A moves X while B recolours X: the colour lands, the move stays', () => {
    // This page (A) moved X and has not had it confirmed.
    const localX = { ...serverX, position: { x: 500, y: 0 }, selected: true };
    // B's update was computed against the server's X, still at the origin.
    const recoloured = {
      ...serverX,
      data: { label: 'X', style: { accent: 'blue' } },
    };
    const result = toFieldLevelDeltas({
      deltas: [replace(serverX, recoloured)],
      localNodes: [localX, y],
      localEdges: [],
      isHeld: held(nodeUnitKey('x', 'position')),
    });
    const [x] = apply([localX, y], result.deltas);
    expect(x.position).toEqual({ x: 500, y: 0 });
    expect(x.data.style).toEqual({ accent: 'blue' });
    expect(x.selected).toBe(true);
    // B did not touch the position, so nothing was kept back.
    expect(result.withheld).toEqual([]);
  });

  it('keeps back a remote value for a unit this page holds', () => {
    const localX = { ...serverX, position: { x: 500, y: 0 } };
    const movedElsewhere = {
      ...serverX,
      position: { x: 900, y: 0 },
      data: { label: 'X', style: { accent: 'blue' } },
    };
    const result = toFieldLevelDeltas({
      deltas: [replace(serverX, movedElsewhere)],
      localNodes: [localX],
      localEdges: [],
      isHeld: held(nodeUnitKey('x', 'position')),
    });
    const [x] = apply([localX], result.deltas);
    expect(x.position).toEqual({ x: 500, y: 0 });
    expect(x.data.style).toEqual({ accent: 'blue' });
    expect(result.withheld).toEqual([
      {
        nodeId: 'x',
        unit: 'position',
        value: { present: true, value: { x: 900, y: 0 } },
      },
    ]);
    expect(result.covered).toEqual(
      new Set([
        nodeUnitKey('x', 'position'),
        nodeUnitKey('x', 'data.style.accent'),
      ]),
    );
  });

  it('emits nothing for a node whose every changed unit is held', () => {
    const localX = { ...serverX, position: { x: 500, y: 0 } };
    const result = toFieldLevelDeltas({
      deltas: [replace(serverX, { ...serverX, position: { x: 900, y: 0 } })],
      localNodes: [localX],
      localEdges: [],
      isHeld: held(nodeUnitKey('x', 'position')),
    });
    expect(result.deltas).toEqual([]);
    expect(result.withheld).toHaveLength(1);
  });

  it('does not replace a node this page no longer has', () => {
    const result = toFieldLevelDeltas({
      deltas: [replace(serverX, { ...serverX, position: { x: 9, y: 9 } })],
      localNodes: [y],
      localEdges: [],
      isHeld: () => false,
    });
    expect(result.deltas).toEqual([]);
  });

  it('merges the echo of a node this page created instead of replacing it', () => {
    // Created here, then moved before the creation was confirmed.
    const local = { ...serverX, position: { x: 300, y: 0 }, selected: true };
    const normalized = {
      ...serverX,
      style: { width: 300, height: 180 },
      data: { label: 'Note 1', style: { accent: 'white' } },
    };
    const result = toFieldLevelDeltas({
      deltas: [{ type: 'INSERT_NODE', node: normalized } as unknown as Delta],
      localNodes: [local],
      localEdges: [],
      isHeld: held(nodeUnitKey('x', 'position')),
    });
    const [x] = apply([local], result.deltas);
    expect(x.position).toEqual({ x: 300, y: 0 });
    expect(x.style).toEqual({ width: 300, height: 180 });
    expect(x.data.label).toBe('Note 1');
    expect(x.selected).toBe(true);
    expect(result.insertedNodeIds).toEqual(new Set(['x']));
    expect(result.deltas[0]?.type).toBe('REPLACE_NODE');
  });

  it('does not re-insert a node deleted here before its creation was confirmed', () => {
    const result = toFieldLevelDeltas({
      deltas: [{ type: 'INSERT_NODE', node: serverX } as unknown as Delta],
      localNodes: [],
      localEdges: [],
      isHeld: held(nodeUnitKey('x', EXISTENCE_UNIT)),
    });
    expect(result.deltas).toEqual([]);
  });

  it("inserts another person's node without its selection", () => {
    const created = { ...serverX, selected: true };
    const result = toFieldLevelDeltas({
      deltas: [{ type: 'INSERT_NODE', node: created } as unknown as Delta],
      localNodes: [y],
      localEdges: [],
      isHeld: () => false,
      stripInsertedSelection: true,
    });
    const nodes = apply([y], result.deltas);
    expect(nodes.map((node) => node.id)).toEqual(['y', 'x']);
    expect(nodes[1]?.selected).toBeUndefined();
  });

  it('leaves a held edge alone and passes the others through', () => {
    const local = { id: 'e1', source: 'x', target: 'y', sourceHandle: 'left' };
    const remote = { ...local, sourceHandle: 'right' };
    const other = { id: 'e2', source: 'y', target: 'x' };
    const result = toFieldLevelDeltas({
      deltas: [
        { type: 'REPLACE_EDGE', prev: local, next: remote },
        { type: 'INSERT_EDGE', edge: other },
      ] as unknown as Delta[],
      localNodes: [serverX, y],
      localEdges: [local],
      isHeld: held(edgeKey('e1')),
    });
    expect(result.deltas).toEqual([{ type: 'INSERT_EDGE', edge: other }]);
    expect(result.covered).toEqual(new Set([edgeKey('e1'), edgeKey('e2')]));
  });

  it("keeps this page's edge selection when the server sends the edge back", () => {
    const stored = { id: 'e1', source: 'x', target: 'y', sourceHandle: 'left' };
    const local = { ...stored, selected: true };
    const rerouted = { ...stored, sourceHandle: 'right' };
    for (const delta of [
      { type: 'REPLACE_EDGE', prev: stored, next: rerouted },
      // The update for this page's own creation of the edge.
      { type: 'INSERT_EDGE', edge: rerouted },
    ] as unknown as Delta[]) {
      const result = toFieldLevelDeltas({
        deltas: [delta],
        localNodes: [serverX, y],
        localEdges: [local],
        isHeld: () => false,
      });
      const { edges } = applyDeltas(
        { nodes: [], edges: [local] } as never,
        result.deltas,
      );
      expect(edges).toEqual([{ ...rerouted, selected: true }]);
    }
  });

  it("does not take an edge's selection from another page", () => {
    const stored = { id: 'e1', source: 'x', target: 'y' };
    const result = toFieldLevelDeltas({
      deltas: [
        {
          type: 'REPLACE_EDGE',
          prev: stored,
          next: { ...stored, selected: true },
        },
        {
          type: 'INSERT_EDGE',
          edge: { id: 'e2', source: 'y', target: 'x', selected: true },
        },
      ] as unknown as Delta[],
      localNodes: [serverX, y],
      localEdges: [{ ...stored, selected: false }],
      isHeld: () => false,
      stripInsertedSelection: true,
    });
    const { edges } = applyDeltas(
      { nodes: [], edges: [{ ...stored, selected: false }] } as never,
      result.deltas,
    );
    expect(edges).toEqual([
      { ...stored, selected: false },
      { id: 'e2', source: 'y', target: 'x' },
    ]);
  });
});
