// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  deriveHeldKeys,
  edgeKey,
  EXISTENCE_UNIT,
  InFlightSet,
  nodeUnitKey,
  type HeldKeys,
} from '../inFlight';

import type { UnitNode } from '../propertyUnits';

const position = (nodeId: string, x: number): HeldKeys =>
  new Map([
    [
      nodeUnitKey(nodeId, 'position'),
      {
        nodeId,
        unit: 'position',
        value: { present: true, value: { x, y: 0 } },
      },
    ],
  ]);
const KEY = nodeUnitKey('x', 'position');

describe('InFlightSet', () => {
  it('holds a key until its entry is released', () => {
    const set = new InFlightSet();
    set.hold('e1', position('x', 0));
    expect(set.isHeld(KEY)).toBe(true);
    expect(set.isHeld(nodeUnitKey('x', 'data.style.accent'))).toBe(false);
    expect(set.isHeld(nodeUnitKey('y', 'position'))).toBe(false);
    set.release('e1', new Set([KEY]));
    expect(set.isHeld(KEY)).toBe(false);
    expect(set.size).toBe(0);
  });

  it('an echo asks only about later entries', () => {
    const set = new InFlightSet();
    set.hold('e1', position('x', 0));
    expect(set.isHeld(KEY, 'e1')).toBe(false);
    set.hold('e2', position('x', 100));
    expect(set.isHeld(KEY, 'e1')).toBe(true);
    expect(set.isHeld(KEY, 'e2')).toBe(true);
  });

  it('a confirmed change needs nothing installed', () => {
    const set = new InFlightSet();
    set.hold('e1', position('x', 0));
    expect(set.release('e1', new Set([KEY]))).toEqual([]);
  });

  it('a withheld remote value is installed when the local change did not land', () => {
    const set = new InFlightSet();
    set.hold('e1', position('x', 0));
    const remote = {
      nodeId: 'x',
      unit: 'position',
      value: { present: true, value: { x: 777, y: 0 } },
    };
    set.withhold(remote);
    // Rejected or no-op: the confirming update covered nothing.
    expect(set.release('e1', new Set())).toEqual([remote]);
  });

  it('a withheld remote value is dropped when the local change was confirmed after it', () => {
    const set = new InFlightSet();
    set.hold('e1', position('x', 0));
    set.withhold({
      nodeId: 'x',
      unit: 'position',
      value: { present: true, value: { x: 777, y: 0 } },
    });
    expect(set.release('e1', new Set([KEY]))).toEqual([]);
  });

  it('a change the server did not take goes back to the value before it', () => {
    const set = new InFlightSet();
    set.hold('e1', position('x', 0));
    expect(set.release('e1', new Set())).toEqual([
      {
        nodeId: 'x',
        unit: 'position',
        value: { present: true, value: { x: 0, y: 0 } },
      },
    ]);
  });

  it('keeps the confirmed value across stacked changes to one unit', () => {
    const set = new InFlightSet();
    set.hold('e1', position('x', 0)); // confirmed 0, local → 100
    set.hold('e2', position('x', 100)); // local → 200; "before" is optimistic
    // e1 is rejected while e2 still holds the unit: nothing to install yet.
    expect(set.release('e1', new Set())).toEqual([]);
    expect(set.isHeld(KEY)).toBe(true);
    // e2 is rejected too: back to the value the server has, 0 — not 100.
    expect(set.release('e2', new Set())).toEqual([
      {
        nodeId: 'x',
        unit: 'position',
        value: { present: true, value: { x: 0, y: 0 } },
      },
    ]);
  });

  it('clear forgets holds and withheld values', () => {
    const set = new InFlightSet();
    set.hold('e1', position('x', 0));
    set.clear();
    expect(set.isHeld(KEY)).toBe(false);
    expect(set.release('e1', new Set())).toEqual([]);
  });
});

describe('deriveHeldKeys', () => {
  const x: UnitNode = {
    id: 'x',
    position: { x: 0, y: 0 },
    data: { label: 'X', content: 'body', style: { accent: 'white' } },
  };
  const y: UnitNode = { id: 'y', position: { x: 0, y: 100 }, data: {} };
  const edge = { id: 'e', source: 'x', target: 'y' };

  it('holds exactly the units a batch changed, with their value before it', () => {
    const next = [{ ...x, style: { width: 50 } }, y];
    const keys = deriveHeldKeys(
      { nodes: [x, y], edges: [edge] },
      { nodes: next, edges: [edge] },
    );
    expect([...keys.keys()]).toEqual([nodeUnitKey('x', 'size')]);
    expect(keys.get(nodeUnitKey('x', 'size'))).toEqual({
      nodeId: 'x',
      unit: 'size',
      value: { present: false },
    });
  });

  it('holds the parent with a changed position: where a node is, is one fact', () => {
    const next = [{ ...x, position: { x: 50, y: 0 } }, y];
    const keys = deriveHeldKeys(
      { nodes: [x, y], edges: [edge] },
      { nodes: next, edges: [edge] },
    );
    expect([...keys.keys()]).toEqual([
      nodeUnitKey('x', 'position'),
      nodeUnitKey('x', 'parent'),
    ]);
    expect(keys.get(nodeUnitKey('x', 'position'))).toEqual({
      nodeId: 'x',
      unit: 'position',
      value: { present: true, value: { x: 0, y: 0 } },
    });
    // The parent did not change; its value before the batch is the canvas.
    expect(keys.get(nodeUnitKey('x', 'parent'))).toEqual({
      nodeId: 'x',
      unit: 'parent',
      value: { present: false },
    });
  });

  it('holds the position with a changed parent, even when the coordinates are the same', () => {
    const frame: UnitNode = { id: 'f', position: { x: 0, y: 0 }, data: {} };
    const keys = deriveHeldKeys(
      { nodes: [frame, x], edges: [] },
      { nodes: [frame, { ...x, parentId: 'f' }], edges: [] },
    );
    expect(keys.has(nodeUnitKey('x', 'parent'))).toBe(true);
    expect(keys.get(nodeUnitKey('x', 'position'))).toEqual({
      nodeId: 'x',
      unit: 'position',
      value: { present: true, value: { x: 0, y: 0 } },
    });
  });

  it('skips units another writer saves', () => {
    const next = [
      {
        ...x,
        data: { label: 'Renamed', content: 'new', style: { accent: 'blue' } },
      },
      y,
    ];
    const keys = deriveHeldKeys(
      { nodes: [x, y], edges: [] },
      { nodes: next, edges: [] },
      (unit) => unit === 'data.label' || unit === 'data.content',
    );
    expect([...keys.keys()]).toEqual([nodeUnitKey('x', 'data.style.accent')]);
  });

  it('holds existence for created and deleted nodes', () => {
    const z: UnitNode = { id: 'z', position: { x: 0, y: 0 }, data: {} };
    const keys = deriveHeldKeys(
      { nodes: [x, y], edges: [edge] },
      { nodes: [x, z], edges: [] },
    );
    expect(new Set(keys.keys())).toEqual(
      new Set([
        nodeUnitKey('y', EXISTENCE_UNIT),
        nodeUnitKey('z', EXISTENCE_UNIT),
        edgeKey('e'),
      ]),
    );
  });

  it('holds only the paint key of the node a reorder moved', () => {
    const a: UnitNode = { id: 'a', parentId: 'f', data: { paintKey: 'a0' } };
    const b: UnitNode = { id: 'b', parentId: 'f', data: { paintKey: 'a1' } };
    const f: UnitNode = { id: 'f', data: { paintKey: 'a0' } };
    // `a` is brought in front of `b`: one node's key, one held unit.
    const moved: UnitNode = { ...a, data: { paintKey: 'a2' } };
    const keys = deriveHeldKeys(
      { nodes: [f, a, b, x], edges: [] },
      { nodes: [f, b, moved, x], edges: [] },
    );
    expect([...keys.keys()]).toEqual([nodeUnitKey('a', 'data.paintKey')]);
    expect(keys.get(nodeUnitKey('a', 'data.paintKey'))).toEqual({
      nodeId: 'a',
      unit: 'data.paintKey',
      // What the server had before this page's reorder.
      value: { present: true, value: 'a0' },
    });
  });

  it('holds nothing for array positions alone', () => {
    const a: UnitNode = { id: 'a', parentId: 'f', data: { paintKey: 'a0' } };
    const b: UnitNode = { id: 'b', parentId: 'f', data: { paintKey: 'a1' } };
    const f: UnitNode = { id: 'f', data: { paintKey: 'a0' } };
    const keys = deriveHeldKeys(
      { nodes: [f, a, b, x], edges: [] },
      { nodes: [f, b, a, x], edges: [] },
    );
    expect(keys.size).toBe(0);
  });

  it('ignores a selection-only change', () => {
    const keys = deriveHeldKeys(
      { nodes: [x, y], edges: [edge] },
      {
        nodes: [{ ...x, selected: true }, y],
        edges: [{ ...edge, selected: true }],
      },
    );
    expect(keys.size).toBe(0);
  });
});
