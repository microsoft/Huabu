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

import { setFrameLayoutCommandSchema } from '../../../types/api/space-operations.js';
import {
  applyStructuredFrameRelayout,
  describeFrameLayout,
} from '../../autoLayout/gridLayout.js';
import { applyOrderedDeltas } from '../../delta.js';
import { diffCanvasState } from '../../diff.js';
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
  describe.each(['column', 'row'] as const)(
    '%s explicit reading order',
    (mode) => {
      const execute = (nodes: Node[], commands: CanvasCommand[]) =>
        executeCanvasCommands(
          { source: 'ui', commands },
          { nodes, edges: [], canvasId: 'layout' },
        ).writeResult;
      const layout = (nodes: Node[]) =>
        nodes.find((node) => node.id === 'frame')?.data.layoutOrder;
      const field = mode === 'column' ? 'frameColumn' : 'frameRow';
      const initial = () => {
        const nodes = scene([{ [field]: 0 }, { [field]: 0 }, { [field]: 1 }]);
        nodes[0].data = { layoutMode: mode, gridCount: 2, sizing: 'manual' };
        nodes.forEach((node) => {
          node.style = { width: 200, height: 100 };
        });
        nodes[1].position = { x: 30, y: 80 };
        nodes[2].position =
          mode === 'column' ? { x: 30, y: 240 } : { x: 300, y: 80 };
        nodes[3].position =
          mode === 'column' ? { x: 300, y: 80 } : { x: 30, y: 240 };
        return nodes;
      };

      it('seeds legacy coordinate ties before a layer reorder and survives relayout and replay', () => {
        const nodes = initial();
        nodes[2].position = { ...nodes[1].position };
        const output = execute(nodes, [
          {
            type: 'REORDER_NODES',
            nodeIds: ['c0' as Cmd['frameId']],
            to: 'top',
          },
        ]);
        expect(layout(output.nodes)).toEqual([['c0', 'c1'], ['c2']]);
        expect(output.nodes.find((node) => node.id === 'c0')?.position).toEqual(
          nodes[1].position,
        );
        const relaid = applyStructuredFrameRelayout(output.nodes, [
          'frame',
        ]).nodes;
        expect(layout(relaid)).toEqual([['c0', 'c1'], ['c2']]);
        expect(
          applyOrderedDeltas(
            { nodes, edges: [] },
            diffCanvasState({ nodes, edges: [] }, output, { orderVersion: 1 }),
          ).nodes,
        ).toEqual(output.nodes);
      });

      it('moves a child relative to a different track without changing paint order', () => {
        const nodes = initial();
        const output = execute(nodes, [
          {
            type: 'SET_FRAME_LAYOUT',
            frameId: 'frame' as Cmd['frameId'],
            mode,
            placements: [{ nodeId: 'c1', before: 'c2' }],
          },
        ]);
        expect(layout(output.nodes)).toEqual([['c0'], ['c1', 'c2']]);
        expect(output.nodes.find((node) => node.id === 'c1')?.data[field]).toBe(
          1,
        );
        expect(output.nodes.map((node) => node.id)).toEqual(
          nodes.map((node) => node.id),
        );
        const restored = JSON.parse(JSON.stringify(output.nodes)) as Node[];
        restored[2].position = { x: -100, y: -100 };
        expect(
          layout(applyStructuredFrameRelayout(restored, ['frame']).nodes),
        ).toEqual([['c0'], ['c1', 'c2']]);
        expect(describeFrameLayout(restored, 'frame')).toEqual({
          mode,
          tracks: [['c0'], ['c1', 'c2']],
        });
      });

      it('updates order through coordinate intent, deletion and mode changes', () => {
        const nodes = applyStructuredFrameRelayout(initial(), ['frame']).nodes;
        const moved = execute(nodes, [
          {
            type: 'SET_NODE_GEOMETRY',
            items: [
              { nodeId: 'c1' as Cmd['frameId'], position: { x: 0, y: 0 } },
            ],
          },
        ]);
        expect(layout(moved.nodes)).toEqual([['c1', 'c0'], ['c2']]);
        const deleted = execute(moved.nodes, [
          { type: 'DELETE_NODES', nodeIds: ['c0' as Cmd['frameId']] },
        ]);
        expect(layout(deleted.nodes)).toEqual([['c1'], ['c2']]);
        const grid = execute(deleted.nodes, [
          {
            type: 'SET_FRAME_LAYOUT',
            frameId: 'frame' as Cmd['frameId'],
            mode: 'grid',
          },
        ]);
        expect(layout(grid.nodes)).toBeUndefined();
        expect(describeFrameLayout(grid.nodes, 'frame')?.mode).toBe('grid');
      });

      it('applies numeric placements sequentially and recognizes the repeated result as a no-op', () => {
        const nodes = applyStructuredFrameRelayout(initial(), ['frame']).nodes;
        const output = execute(nodes, [
          {
            type: 'SET_FRAME_LAYOUT',
            frameId: 'frame' as Cmd['frameId'],
            mode,
            placements: [
              { nodeId: 'c2', track: 0, at: 'start' },
              { nodeId: 'c0', track: 1, at: 'end' },
            ],
          },
        ]);
        expect(layout(output.nodes)).toEqual([['c2', 'c1'], ['c0']]);
        const command: Cmd = {
          type: 'SET_FRAME_LAYOUT',
          frameId: 'frame' as Cmd['frameId'],
          mode,
          placements: [{ nodeId: 'c2', track: 0, at: 'end' }],
        };
        const reordered = execute(output.nodes, [command]);
        expect(layout(reordered.nodes)).toEqual([['c1', 'c2'], ['c0']]);
        expect(run(command, reordered.nodes).applied).toBe(false);
      });

      it('reconciles both Frames on reparent and removes the last deleted member', () => {
        const nodes = applyStructuredFrameRelayout(initial(), ['frame']).nodes;
        const nodeIds = nodes
          .filter((node) => node.parentId === 'frame')
          .map((node) => node.id as Cmd['frameId']);
        nodes.push({
          id: 'target',
          type: 'frame',
          position: { x: 1000, y: 1000 },
          style: { width: 400, height: 400 },
          data: { layoutMode: mode, gridCount: 1, sizing: 'manual' },
        });
        const moved = execute(nodes, [
          {
            type: 'SET_NODE_PARENT',
            nodeIds,
            parentId: 'target' as Cmd['frameId'],
          },
        ]);
        expect(layout(moved.nodes)).toEqual([]);
        const target = describeFrameLayout(moved.nodes, 'target');
        expect(target?.mode).toBe(mode);
        if (!target || target.mode === 'grid')
          throw new Error('Expected tracks');
        expect(target.tracks.flat().sort()).toEqual(['c0', 'c1', 'c2']);
        const deleted = execute(moved.nodes, [
          {
            type: 'DELETE_NODES',
            nodeIds,
          },
        ]);
        expect(dataOf(deleted.nodes, 'target').layoutOrder).toEqual([]);
      });

      it.each([
        'missing-anchor',
        'foreign-anchor',
        'locked',
        'duplicate',
        'mixed-fields',
      ])('rejects %s without partial writes', (reason) => {
        const nodes = initial();
        if (reason === 'locked') nodes[2].data.locked = true;
        nodes.push({
          id: 'foreign',
          type: 'text',
          position: { x: 0, y: 0 },
          data: {},
        });
        const before = structuredClone(nodes);
        const result = run(
          {
            type: 'SET_FRAME_LAYOUT',
            frameId: 'frame' as Cmd['frameId'],
            mode,
            placements: [
              { nodeId: 'c0', after: 'c2' },
              {
                nodeId: reason === 'duplicate' ? 'c0' : 'c1',
                before:
                  reason === 'missing-anchor'
                    ? 'absent'
                    : reason === 'foreign-anchor'
                      ? 'foreign'
                      : 'c2',
              },
            ],
            ...(reason === 'mixed-fields' ? { cells: [] } : {}),
          },
          nodes,
        );
        expect(result.applied).toBe(false);
        expect(result.nodes).toEqual(before);
        expect(nodes).toEqual(before);
      });
    },
  );

  it('validates exclusive relative placement shapes at the Agent boundary', () => {
    expect(
      setFrameLayoutCommandSchema.safeParse({
        type: 'SET_FRAME_LAYOUT',
        frameId: 'f',
        mode: 'column',
        placements: [{ nodeId: 'b', after: 'a' }],
      }).success,
    ).toBe(true);
    expect(
      setFrameLayoutCommandSchema.safeParse({
        type: 'SET_FRAME_LAYOUT',
        frameId: 'f',
        mode: 'column',
        placements: [{ nodeId: 'b', after: 'a', before: 'c' }],
      }).success,
    ).toBe(false);
  });

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
