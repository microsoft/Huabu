// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The one rule for when a track key stops meaning anything
 * (`settleTrackKeys`), and that the executor applies it to every command.
 */

import { describe, expect, it } from 'vitest';

import { readTrackKey, settleTrackKeys } from '../autoLayout/layoutOrder.js';
import { executeCanvasCommands } from '../executor.js';

import type { CanvasCommand } from '../../types/canvas/command.js';
import type { Node } from '@xyflow/react';

const frame = (id: string, layoutMode: string, parentId?: string): Node =>
  ({
    id,
    type: 'frame',
    ...(parentId ? { parentId } : {}),
    position: { x: 0, y: 0 },
    style: { width: 400, height: 600 },
    data: { layoutMode, gridCount: 2, sizing: 'manual' },
  }) as Node;
const child = (
  id: string,
  parentId: string | undefined,
  data: Record<string, unknown>,
): Node =>
  ({
    id,
    type: 'text',
    ...(parentId ? { parentId } : {}),
    position: { x: 20, y: 60 },
    style: { width: 150, height: 80 },
    data,
  }) as Node;
const keyed = (nodes: readonly Node[], id: string) =>
  readTrackKey(nodes.find((node) => node.id === id) as Node);
const withData = (node: Node, data: Record<string, unknown>): Node =>
  ({ ...node, data: { ...node.data, ...data } }) as Node;

describe('settleTrackKeys', () => {
  const a = child('a', 'f', { frameColumn: 0, trackKey: 'a1' });
  const before = [frame('f', 'column'), frame('g', 'column'), a];

  it.each([
    ['another parent', { ...a, parentId: 'g' } as Node],
    ['no parent', (({ parentId: _parentId, ...rest }) => rest)(a) as Node],
    ['another track', withData(a, { frameColumn: 1 })],
  ])('drops a key the child still carries in %s', (_name, moved) => {
    const after = [before[0], before[1], moved];
    expect(keyed(settleTrackKeys(after, before), 'a')).toBeUndefined();
  });

  it('drops the keys of the children of a Frame switched to another mode', () => {
    const after = [frame('f', 'row'), before[1], a];
    expect(keyed(settleTrackKeys(after, before), 'a')).toBeUndefined();
  });

  it('keeps a key the write changed, and one of a child it names as placed', () => {
    const rekeyed = withData(a, { frameColumn: 1, trackKey: 'a5' });
    expect(
      keyed(settleTrackKeys([before[0], before[1], rekeyed], before), 'a'),
    ).toBe('a5');
    const sameKey = withData(a, { frameColumn: 1 });
    expect(
      keyed(
        settleTrackKeys([before[0], before[1], sameKey], before, new Set('a')),
        'a',
      ),
    ).toBe('a1');
  });

  it('keeps the key of a node created with its Frame, drops one created into a Frame that was there', () => {
    const created = child('new', 'f', { frameColumn: 0, trackKey: 'a0' });
    expect(
      keyed(settleTrackKeys([...before, created], before), 'new'),
    ).toBeUndefined();
    const copied = [
      frame('h', 'column'),
      child('new', 'h', { frameColumn: 0, trackKey: 'a0' }),
    ];
    expect(keyed(settleTrackKeys([...before, ...copied], before), 'new')).toBe(
      'a0',
    );
  });

  it('returns the same array when no key is left meaningless', () => {
    const moved = [
      before[0],
      before[1],
      { ...a, position: { x: 30, y: 90 } } as Node,
    ];
    expect(settleTrackKeys(moved, before)).toBe(moved);
    expect(settleTrackKeys(before, before)).toBe(before);
  });
});

describe('the executor settles track keys after every command', () => {
  const run = (nodes: Node[], commands: unknown[]) =>
    executeCanvasCommands(
      { source: 'ui', commands: commands as CanvasCommand[] },
      { nodes, edges: [], canvasId: 'settle' },
    ).writeResult.nodes;
  const scene = () => [
    frame('node-f', 'column'),
    frame('node-g', 'column'),
    {
      ...child('node-a', 'node-f', { frameColumn: 0, trackKey: 'a1' }),
      position: { x: 20, y: 400 },
    },
    {
      ...child('node-b', 'node-g', { frameColumn: 0, trackKey: 'a1' }),
      position: { x: 20, y: 60 },
    },
    {
      ...child('node-c', 'node-g', { frameColumn: 0, trackKey: 'a2' }),
      position: { x: 20, y: 200 },
    },
  ];

  it('a child moved to another Frame is read where it was put, not by the key it had', () => {
    // `node-a` holds the same key as `node-b`, the first child of the Frame
    // it moves into, and stands below that Frame's last child.
    const moved = run(scene(), [
      {
        type: 'SET_NODE_PARENT',
        nodeIds: ['node-a'],
        parentId: 'node-g',
      },
    ]);
    const order = ['node-a', 'node-b', 'node-c'].sort((x, y) =>
      (keyed(moved, x) as string) < (keyed(moved, y) as string) ? -1 : 1,
    );
    expect(order).toEqual(['node-b', 'node-c', 'node-a']);
  });

  it('a restored node comes back with the key it had', () => {
    const nodes = scene();
    const removed = run(nodes, [{ type: 'DELETE_NODES', nodeIds: ['node-b'] }]);
    const restored = run(removed, [
      {
        type: 'RESTORE_NODES',
        nodes: [nodes.find((node) => node.id === 'node-b')],
      },
    ]);
    expect(keyed(restored, 'node-b')).toBe('a1');
  });
});
