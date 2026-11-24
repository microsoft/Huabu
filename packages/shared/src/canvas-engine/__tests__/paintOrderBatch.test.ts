// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Paint keys inside one batch: a later command must not read a key an
 * earlier command of the batch left meaningless, and a key a command names
 * must survive the end-of-batch settlement.
 */

import { describe, expect, it } from 'vitest';

import { readTrackKey } from '../autoLayout/layoutOrder.js';
import { readPaintKey } from '../container/paintOrder.js';
import { executeCanvasCommands } from '../executor.js';
import { seedNodeOrder } from '../seedOrder.js';

import type { CanvasCommand } from '../../types/canvas/command.js';
import type { NestableNode } from '../container/tree.js';
import type { Node } from '@xyflow/react';

const node = (
  id: string,
  type: string,
  data: Record<string, unknown>,
  parentId?: string,
  y = 0,
): Node =>
  ({
    id,
    type,
    ...(parentId ? { parentId } : {}),
    position: { x: 20, y },
    style: { width: 200, height: 100 },
    data,
  }) as Node;
const run = (nodes: Node[], commands: unknown[]) =>
  executeCanvasCommands(
    { source: 'ui', commands: commands as CanvasCommand[] },
    { nodes, edges: [], canvasId: 'paint' },
  ).writeResult.nodes;
const children = (nodes: readonly Node[], parentId?: string) =>
  nodes.filter((n) => (n.parentId ?? undefined) === parentId).map((n) => n.id);

describe('paint keys inside one batch', () => {
  it('a reorder after a reparent reads where the reparented node was put, not its old key', () => {
    const nodes = [
      node('node-f', 'frame', { paintKey: 'a2', sizing: 'manual' }),
      node('node-x', 'text', { paintKey: 'a5' }, 'node-f'),
      node('node-y', 'text', { paintKey: 'a6' }, 'node-f'),
      // In front of the Frame at the root, with a key that would rank it
      // behind both children.
      node('node-b', 'text', { paintKey: 'a3' }),
    ];
    const out = run(nodes, [
      { type: 'SET_NODE_PARENT', nodeIds: ['node-b'], parentId: 'node-f' },
      { type: 'REORDER_NODES', nodeIds: ['node-y'], to: 'top' },
    ]);
    // `node-b` entered the Frame in front of its children; `node-y` then
    // went in front of it. Read by its old key, `node-b` would be at the back.
    expect(children(out, 'node-f')).toEqual(['node-x', 'node-b', 'node-y']);
  });

  it('a restored node keeps the paint key it is restored with, also when it equals the one it had elsewhere', () => {
    const nodes = [
      node('node-f', 'frame', { paintKey: 'a1', sizing: 'manual' }),
      node('node-a', 'text', { paintKey: 'a0' }, 'node-f'),
    ];
    // An undo puts `node-a` back at the root, behind the Frame, with the
    // key it had there: the same value it happens to carry in the Frame.
    const out = run(nodes, [
      {
        type: 'RESTORE_NODES',
        nodes: [node('node-a', 'text', { paintKey: 'a0' })],
        replace: ['node-a'],
      },
    ]);
    expect(children(out)).toEqual(['node-a', 'node-f']);
    expect(readPaintKey(out[0] as NestableNode)).toBe('a0');
  });
});

describe('a reorder after an earlier command of the batch named a paint key', () => {
  it('follows a restore: the restored node is where its key puts it', () => {
    const nodes = [
      node('node-f', 'frame', { paintKey: 'a1', sizing: 'manual' }),
      node('node-a', 'text', { paintKey: 'a0' }, 'node-f'),
      node('node-b', 'text', { paintKey: 'a2' }),
    ];
    const out = run(nodes, [
      {
        type: 'RESTORE_NODES',
        nodes: [node('node-a', 'text', { paintKey: 'a0' })],
        replace: ['node-a'],
      },
      { type: 'REORDER_NODES', nodeIds: ['node-b'], to: 'bottom' },
    ]);
    expect(children(out)).toEqual(['node-b', 'node-a', 'node-f']);
  });

  it('follows a patched key: the patched node is where its new key puts it', () => {
    const nodes = [
      node('node-a', 'text', { paintKey: 'a0' }),
      node('node-b', 'text', { paintKey: 'a1' }),
      node('node-c', 'text', { paintKey: 'a2' }),
    ];
    const out = run(nodes, [
      {
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: 'node-a', patch: { paintKey: 'a3' } }],
      },
      { type: 'REORDER_NODES', nodeIds: ['node-b'], to: 'top' },
    ]);
    expect(children(out)).toEqual(['node-c', 'node-a', 'node-b']);
  });
});

describe('a locked Column Frame stored without a reading order', () => {
  it('is given its reading order by the read like any other', () => {
    const stored = [
      node('node-f', 'frame', {
        layoutMode: 'column',
        gridCount: 1,
        sizing: 'manual',
        locked: true,
      }),
      node('node-a', 'text', { frameColumn: 0 }, 'node-f', 60),
      node('node-b', 'text', { frameColumn: 0 }, 'node-f', 200),
    ];
    const read = seedNodeOrder(stored as NestableNode[]) as Node[];
    const keys = ['node-a', 'node-b'].map((id) =>
      readTrackKey(read.find((n) => n.id === id) as Node),
    );
    expect(keys.every((key) => key !== undefined)).toBe(true);
    expect((keys[0] as string) < (keys[1] as string)).toBe(true);
    // The Frame itself is as it was stored.
    expect(read.find((n) => n.id === 'node-f')?.data.locked).toBe(true);
  });
});
