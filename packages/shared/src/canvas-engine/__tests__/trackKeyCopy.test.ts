// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Track keys across a copy: a copy gets new ids and may land in another
 * Frame, so a key has to mean the same after it as before.
 */

import { describe, expect, it } from 'vitest';

import {
  readTrackKey,
  withDistinctTrackKeys,
} from '../autoLayout/layoutOrder.js';
import { executeCanvasCommands } from '../executor.js';

import type { CanvasCommand } from '../../types/canvas/command.js';
import type { Node } from '@xyflow/react';

const columnFrame = (id: string): Node =>
  ({
    id,
    type: 'frame',
    position: { x: 0, y: 0 },
    style: { width: 400, height: 600 },
    data: { layoutMode: 'column', gridCount: 1, sizing: 'manual' },
  }) as Node;
const child = (id: string, parentId: string, trackKey?: string): Node =>
  ({
    id,
    type: 'text',
    parentId,
    position: { x: 20, y: 60 },
    style: { width: 200, height: 80 },
    data: { frameColumn: 0, ...(trackKey ? { trackKey } : {}) },
  }) as Node;
const keyOf = (nodes: readonly Node[], id: string) =>
  readTrackKey(nodes.find((node) => node.id === id) as Node);

describe('withDistinctTrackKeys', () => {
  it('writes the id order of children that share a key into their keys', () => {
    // Two pages put a child into the same gap at once: one key, told apart
    // by id. `node-a` reads before `node-b`.
    const nodes = [
      columnFrame('frame'),
      child('node-b', 'frame', 'a1'),
      child('node-a', 'frame', 'a1'),
      child('node-z', 'frame', 'a2'),
    ];
    const result = withDistinctTrackKeys(nodes);
    const [a, b, z] = ['node-a', 'node-b', 'node-z'].map(
      (id) => keyOf(result, id) as string,
    );
    // Now the keys alone say it, whatever ids a copy is given.
    expect(a < b && b < z).toBe(true);
    expect(a).toBe('a1');
    expect(z).toBe('a2');
  });

  it('returns the same array when no key is shared, or the Frame is absent', () => {
    const distinct = [
      columnFrame('frame'),
      child('node-a', 'frame', 'a1'),
      child('node-b', 'frame', 'a2'),
    ];
    expect(withDistinctTrackKeys(distinct)).toBe(distinct);
    const orphans = [
      child('node-a', 'frame', 'a1'),
      child('node-b', 'frame', 'a1'),
    ];
    expect(withDistinctTrackKeys(orphans)).toBe(orphans);
  });
});

describe('a created node and the track key it was copied with', () => {
  const create = (nodes: Node[], created: unknown[]) =>
    executeCanvasCommands(
      {
        source: 'ui',
        commands: [{ type: 'CREATE_NODES', nodes: created } as CanvasCommand],
      },
      { nodes, edges: [], canvasId: 'copy' },
    ).writeResult.nodes;

  it('is read where it was put when it is created by itself in a Frame', () => {
    const nodes = [
      columnFrame('node-frame'),
      { ...child('node-a', 'node-frame', 'a1'), position: { x: 20, y: 60 } },
      { ...child('node-b', 'node-frame', 'a2'), position: { x: 20, y: 160 } },
    ] as Node[];
    // A copy of a child of some other Frame, pasted below the last child.
    // Its key ranked it first where it came from.
    const result = create(nodes, [
      {
        id: 'node-pasted',
        nodeType: 'text',
        parentId: 'node-frame',
        position: { x: 20, y: 400 },
        size: { width: 200, height: 80 },
        data: { frameColumn: 0, trackKey: 'a0' },
      },
    ]);
    const order = ['node-a', 'node-b', 'node-pasted'].sort((x, y) =>
      (keyOf(result, x) as string) < (keyOf(result, y) as string) ? -1 : 1,
    );
    expect(order).toEqual(['node-a', 'node-b', 'node-pasted']);
  });

  it('keeps its place among its siblings when it is created with its Frame', () => {
    const result = create(
      [],
      [
        {
          id: 'node-frame',
          nodeType: 'frame',
          position: { x: 0, y: 0 },
          size: { width: 400, height: 600 },
          data: { layoutMode: 'column', gridCount: 1, sizing: 'manual' },
        },
        // Stands lower, reads first.
        {
          id: 'node-first',
          nodeType: 'text',
          parentId: 'node-frame',
          position: { x: 20, y: 300 },
          size: { width: 200, height: 80 },
          data: { frameColumn: 0, trackKey: 'a1' },
        },
        {
          id: 'node-second',
          nodeType: 'text',
          parentId: 'node-frame',
          position: { x: 20, y: 60 },
          size: { width: 200, height: 80 },
          data: { frameColumn: 0, trackKey: 'a2' },
        },
      ],
    );
    expect(keyOf(result, 'node-first')).toBe('a1');
    expect(keyOf(result, 'node-second')).toBe('a2');
  });
});
