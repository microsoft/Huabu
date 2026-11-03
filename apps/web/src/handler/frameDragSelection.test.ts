// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { getFrameDragRoots } from './frameDragSelection';

import type { Node } from '@xyflow/react';

const frame = (id: string, parentId?: string): Node => ({
  id,
  parentId,
  type: 'frame',
  position: { x: 100, y: 200 },
  data: {},
});
const child = (id: string, parentId?: string): Node => ({
  id,
  parentId,
  type: 'note',
  selected: true,
  position: { x: 30, y: 50 },
  data: {},
});
const roots = (nodes: Node[], ids: string[]) =>
  getFrameDragRoots(
    nodes,
    nodes.filter((node) => ids.includes(node.id)),
  ).map((node) => node.id);

describe('movement-only Frame selection', () => {
  it('carries fully covered nested Frames once without changing selection', () => {
    const nodes = [
      frame('outer'),
      frame('inner', 'outer'),
      child('a', 'inner'),
      child('b', 'inner'),
      child('c', 'outer'),
    ];
    expect(roots(nodes, ['a', 'b', 'c'])).toEqual(['outer']);
    expect(roots(nodes, ['a', 'b'])).toEqual(['inner']);
    expect(roots(nodes, ['outer', 'inner', 'a', 'b', 'c'])).toEqual(['outer']);
    expect(
      nodes.filter((node) => node.selected).map((node) => node.id),
    ).toEqual(['a', 'b', 'c']);
  });

  it('preserves partial and single-node drags and ignores empty Frames', () => {
    const nodes = [
      frame('f'),
      child('a', 'f'),
      child('b', 'f'),
      frame('empty'),
      child('outside'),
    ];
    expect(roots(nodes, ['a', 'outside'])).toEqual(['a', 'outside']);
    expect(roots([frame('f'), child('a', 'f')], ['a'])).toEqual(['a']);
    expect(roots(nodes, ['a', 'b', 'outside'])).toEqual(['f', 'outside']);
  });

  it.each([{ locked: true }, { draggable: false }])(
    'does not infer an immovable Frame: %j',
    (restriction) => {
      const f = frame('f');
      if ('locked' in restriction) f.data.locked = restriction.locked;
      if ('draggable' in restriction) f.draggable = restriction.draggable;
      expect(roots([f, child('a', 'f'), child('b', 'f')], ['a', 'b'])).toEqual([
        'a',
        'b',
      ]);
    },
  );

  it('requires unselected hidden nodes and Sketch nodes to be covered too', () => {
    const nodes = [
      frame('f'),
      child('a', 'f'),
      child('b', 'f'),
      { ...child('ink', 'f'), type: 'sketch', hidden: true, selected: false },
    ];
    expect(roots(nodes, ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('counts selected descendants before pruning nested movement roots', () => {
    const nodes = [
      frame('outer'),
      { ...frame('inner', 'outer'), selected: true },
      child('a', 'inner'),
    ];
    expect(roots(nodes, ['inner', 'a'])).toEqual(['outer']);
    expect(roots(nodes, ['inner'])).toEqual(['inner']);
  });
});
