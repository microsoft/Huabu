// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file `SET_FRAME_LAYOUT`'s `cells` parameter.
 *
 * A structured frame computes every child position from its cell, so a
 * caller who cares where things land cannot say so through `position`.
 * `cells` is that channel, and it rides on the layout command itself so
 * the end-of-batch relayout already sees the assignments — a preceding
 * `MERGE_NODE_DATA` would have been an ordering trap.
 */

import { describe, it, expect } from 'vitest';

import { executeCanvasCommands } from '../../executor.js';
import { HANDLERS } from '../index.js';

import type { CanvasCommand } from '../../../types/canvas/command.js';
import type { Node } from '@xyflow/react';

type Cmd = Extract<CanvasCommand, { type: 'SET_FRAME_LAYOUT' }>;

function run(cmd: Cmd, nodes: Node[]) {
  return HANDLERS.SET_FRAME_LAYOUT(
    cmd as never,
    {
      nodes,
      edges: [],
    } as never,
  );
}

function scene(childData: Array<Record<string, unknown>> = [{}, {}]): Node[] {
  return [
    {
      id: 'frame',
      type: 'frame',
      position: { x: 0, y: 0 },
      data: { layoutMode: 'free' },
    } as Node,
    ...childData.map(
      (data, index) =>
        ({
          id: `c${index}`,
          type: 'text',
          parentId: 'frame',
          position: { x: 0, y: index * 100 },
          data,
        }) as Node,
    ),
  ];
}

const dataOf = (nodes: Node[], id: string) =>
  nodes.find((n) => n.id === id)?.data as Record<string, unknown>;

describe('SET_FRAME_LAYOUT cells', () => {
  it.each([false, true])(
    'preserves explicit sparse cells during execution (earlier count command: %s)',
    (earlierCount) => {
      const nodes = scene([
        { frameColumn: 0, frameRow: 0 },
        { frameColumn: 2, frameRow: 0 },
        { frameColumn: 2, frameRow: 2 },
      ]).map((node) => ({
        ...node,
        id: `node-${node.id}`,
        parentId: node.parentId ? `node-${node.parentId}` : undefined,
        style: { width: 100, height: 50 },
      }));
      nodes[0].data = { layoutMode: 'grid', gridCount: 3 };
      const count: Cmd = {
        type: 'SET_FRAME_LAYOUT',
        frameId: 'node-frame',
        mode: 'grid',
        gridCount: 3,
      };
      const result = executeCanvasCommands(
        {
          source: 'ui',
          commands: [
            ...(earlierCount ? [count] : []),
            {
              ...count,
              cells: [
                { nodeId: 'node-c0', column: 0, row: 0 },
                { nodeId: 'node-c1', column: 2, row: 0 },
                { nodeId: 'node-c2', column: 2, row: 2 },
              ],
            },
          ],
        },
        { nodes, edges: [], canvasId: 'canvas' },
      );
      for (const original of nodes.slice(1)) {
        expect(dataOf(result.writeResult.nodes, original.id)).toMatchObject(
          original.data,
        );
      }
    },
  );

  it('pins each child to the cell it names', () => {
    const result = run(
      {
        type: 'SET_FRAME_LAYOUT',
        frameId: 'frame' as Cmd['frameId'],
        mode: 'grid',
        gridCount: 2,
        cells: [
          { nodeId: 'c0' as Cmd['frameId'], column: 0, row: 0 },
          { nodeId: 'c1' as Cmd['frameId'], column: 1, row: 2 },
        ],
      },
      scene(),
    );

    expect(result.applied).toBe(true);
    expect(dataOf(result.nodes, 'c0')).toMatchObject({
      frameColumn: 0,
      frameRow: 0,
    });
    expect(dataOf(result.nodes, 'c1')).toMatchObject({
      frameColumn: 1,
      frameRow: 2,
    });
  });

  it('applies even when the layout fields are unchanged', () => {
    // Re-pinning cells without touching mode / count / sizing is a
    // legitimate edit; treating it as a no-op would drop it silently.
    const nodes = scene();
    nodes[0].data = { layoutMode: 'grid', gridCount: 2 };

    const result = run(
      {
        type: 'SET_FRAME_LAYOUT',
        frameId: 'frame' as Cmd['frameId'],
        mode: 'grid',
        gridCount: 2,
        cells: [{ nodeId: 'c1' as Cmd['frameId'], column: 1, row: 1 }],
      },
      nodes,
    );

    expect(result.applied).toBe(true);
    expect(dataOf(result.nodes, 'c1')).toMatchObject({
      frameColumn: 1,
      frameRow: 1,
    });
  });

  it('sheds the legacy index it would otherwise contradict', () => {
    const result = run(
      {
        type: 'SET_FRAME_LAYOUT',
        frameId: 'frame' as Cmd['frameId'],
        mode: 'grid',
        gridCount: 2,
        cells: [{ nodeId: 'c0' as Cmd['frameId'], column: 1 }],
      },
      scene([{ frameSlot: 0 }, {}]),
    );

    expect('frameSlot' in dataOf(result.nodes, 'c0')).toBe(false);
    expect(dataOf(result.nodes, 'c0').frameColumn).toBe(1);
  });

  it('ignores a cell for a node that is not a child of this frame', () => {
    const nodes = scene();
    nodes.push({
      id: 'outsider',
      type: 'text',
      position: { x: 0, y: 0 },
      data: {},
    } as Node);

    const result = run(
      {
        type: 'SET_FRAME_LAYOUT',
        frameId: 'frame' as Cmd['frameId'],
        mode: 'column',
        gridCount: 2,
        cells: [{ nodeId: 'outsider' as Cmd['frameId'], column: 1 }],
      },
      nodes,
    );

    expect(dataOf(result.nodes, 'outsider').frameColumn).toBeUndefined();
  });

  it('leaves a child alone when its cell does not actually change', () => {
    // `cells` and a mode change both address every child, but a node
    // reported as mutated is re-persisted and re-broadcast whether or
    // not it moved, so the ones that stay put keep their identity.
    const nodes = scene([
      { frameColumn: 0, frameRow: 0 },
      { frameColumn: 1, frameRow: 0 },
    ]);
    nodes[0].data = { layoutMode: 'grid', gridCount: 2 };

    const result = run(
      {
        type: 'SET_FRAME_LAYOUT',
        frameId: 'frame' as Cmd['frameId'],
        mode: 'grid',
        gridCount: 2,
        cells: [
          { nodeId: 'c0' as Cmd['frameId'], column: 0, row: 0 },
          { nodeId: 'c1' as Cmd['frameId'], column: 1, row: 1 },
        ],
      },
      nodes,
    );

    expect(result.nodes[1]).toBe(nodes[1]);
    expect(result.mutatedNodes?.map((n) => n.id)).toEqual(['frame', 'c1']);
  });
});
