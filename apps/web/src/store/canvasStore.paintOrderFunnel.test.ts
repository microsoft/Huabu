// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => ({ orderByPaintKeys: vi.fn() }));
vi.mock('@huabu/shared/canvas-engine', async (actual) => {
  const real = await actual<typeof engineModule>();
  engine.orderByPaintKeys.mockImplementation(real.orderByPaintKeys);
  return { ...real, orderByPaintKeys: engine.orderByPaintKeys };
});

import useCanvasStore from './canvasStore';

import type * as engineModule from '@huabu/shared/canvas-engine';
import type { Node } from '@xyflow/react';

/**
 * The store keeps `nodes` in paint order on every write, whoever writes:
 * the array follows the `data.paintKey` each node carries, and a write that
 * changes no key, parent or membership is stored as it is given.
 */

const note = (id: string, paintKey?: string, parentId?: string): Node => ({
  id,
  type: 'note',
  position: { x: 0, y: 0 },
  ...(parentId ? { parentId } : {}),
  data: { type: 'note', label: id, ...(paintKey ? { paintKey } : {}) },
});
const frame = (id: string, paintKey: string): Node => ({
  id,
  type: 'frame',
  position: { x: 0, y: 0 },
  data: { type: 'frame', label: id, paintKey },
});
const withKey = (node: Node, paintKey: string): Node => ({
  ...node,
  data: { ...node.data, paintKey },
});

const state = () => useCanvasStore.getState();
const ids = () => state().nodes.map((node) => node.id);

/** The ways a `nodes` array reaches the store. */
const writers: Record<string, (nodes: Node[]) => void> = {
  'an action (`set`)': (nodes) =>
    state().onNodesChange(
      nodes.map((item) => ({ type: 'replace', id: item.id, item })),
    ),
  '`setState` from outside the store': (nodes) =>
    useCanvasStore.setState({ nodes }),
  '`setState` with an updater': (nodes) =>
    useCanvasStore.setState(() => ({ nodes })),
  '`_setStateRaw`': (nodes) => state()._setStateRaw({ nodes }),
};

beforeEach(() => {
  state()._setStateRaw({
    canvasId: '',
    isLoading: false,
    edges: [],
    nodes: [note('a', 'a0'), note('b', 'a1'), note('c', 'a2')],
  });
  engine.orderByPaintKeys.mockClear();
});

describe.each(Object.entries(writers))('a write through %s', (_name, write) => {
  it('puts a node whose paint key changed where the key says', () => {
    const [a, b, c] = state().nodes;
    write([withKey(a, 'a3'), b, c]);
    expect(ids()).toEqual(['b', 'c', 'a']);
  });

  it('puts a node that changed parent inside its new parent', () => {
    state()._setStateRaw({
      nodes: [frame('f', 'a0'), note('a', 'a1'), note('b', 'a2')],
    });
    const [f, a, b] = state().nodes;
    write([f, a, { ...b, parentId: 'f' }]);
    expect(ids()).toEqual(['f', 'b', 'a']);
  });

  it('stores a position-only replacement as given, without ordering it', () => {
    const next = state().nodes.map((node) => ({
      ...node,
      position: { x: 10, y: 20 },
    }));
    engine.orderByPaintKeys.mockClear();
    write(next);
    expect(state().nodes.map((node) => node.position.x)).toEqual([10, 10, 10]);
    expect(engine.orderByPaintKeys).not.toHaveBeenCalled();
  });
});

describe('what the store leaves alone', () => {
  it('keeps the very array of a write that changes no key, parent or member', () => {
    const next = state().nodes.map((node) => ({
      ...node,
      position: { x: 5, y: 5 },
      data: { ...node.data, label: 'renamed' },
    }));
    state()._setStateRaw({ nodes: next });
    expect(state().nodes).toBe(next);
    expect(engine.orderByPaintKeys).not.toHaveBeenCalled();
  });

  it('does not look at nodes when a write carries none', () => {
    const before = state().nodes;
    useCanvasStore.setState({ canvasTitle: 'Renamed' });
    expect(state().nodes).toBe(before);
    expect(engine.orderByPaintKeys).not.toHaveBeenCalled();
  });

  it('keeps a node without a key right after the sibling it follows', () => {
    const [a, b, c] = state().nodes;
    state()._setStateRaw({ nodes: [a, note('new'), b, c] });
    expect(ids()).toEqual(['a', 'new', 'b', 'c']);
    // It stays there when a sibling's key later moves that sibling.
    const [, added] = state().nodes;
    state()._setStateRaw({ nodes: [a, added, withKey(b, 'a9'), c] });
    expect(ids()).toEqual(['a', 'new', 'c', 'b']);
  });

  it('writes no key: a node without one moves with the sibling it follows', () => {
    const [a, b, c] = state().nodes;
    state()._setStateRaw({ nodes: [withKey(a, 'a3'), note('new'), b, c] });
    expect(state().nodes.map((node) => [node.id, node.data.paintKey])).toEqual([
      ['b', 'a1'],
      ['c', 'a2'],
      ['a', 'a3'],
      ['new', undefined],
    ]);
  });
});
