// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { AGENT_CANVAS_COMMAND_TYPES } from '@huabu/shared';

import { reconstructChangesFromCommands } from './helpers';

const NODE_1 = 'node-00000000-0000-4000-8000-000000000001';
const NODE_2 = 'node-00000000-0000-4000-8000-000000000002';
const EDGE_1 = 'edge-00000000-0000-4000-8000-000000000001';

const commands: Array<Record<string, unknown>> = [
  {
    type: 'CREATE_NODES',
    nodes: [{ id: NODE_1, nodeType: 'note', data: { label: 'Note' } }],
  },
  { type: 'DELETE_NODES', nodeIds: [NODE_1] },
  { type: 'MERGE_NODE_DATA', patches: [{ nodeId: NODE_1, patch: {} }] },
  { type: 'SET_NODE_PARENT', nodeIds: [NODE_1], parentId: NODE_2 },
  { type: 'DISSOLVE_FRAME', frameId: NODE_2 },
  { type: 'SET_NODE_GEOMETRY', items: [{ nodeId: NODE_1 }] },
  { type: 'REORDER_NODES', nodeIds: [NODE_1], to: 'top' },
  { type: 'CONNECT_NODES', edges: [{ source: NODE_1, target: NODE_2 }] },
  { type: 'DISCONNECT_EDGES', edges: [EDGE_1] },
  { type: 'SET_EDGE_STYLE', edges: [{ edge: EDGE_1, style: {} }] },
  { type: 'ALIGN_NODES', nodeIds: [NODE_1, NODE_2], direction: 'left' },
  { type: 'DISTRIBUTE_NODES', nodeIds: [NODE_1, NODE_2] },
  { type: 'SET_FRAME_LAYOUT', frameId: NODE_2, mode: 'column', gridCount: 2 },
  {
    type: 'SET_PORTAL_NODE_PINS',
    updates: [
      {
        sourceCanvasId: 'canvas-00000000-0000-4000-8000-000000000001',
        sourceNodeIds: [NODE_1],
        pinned: true,
      },
    ],
  },
];

describe('reconstructChangesFromCommands', () => {
  it('covers every Agent CanvasCommand type with a human-display model', () => {
    const changes = reconstructChangesFromCommands(commands);
    const rawCommandLabels = new Set(commands.map((command) => command.type));

    expect([...rawCommandLabels].sort()).toEqual(
      [...AGENT_CANVAS_COMMAND_TYPES].sort(),
    );
    expect(changes).toHaveLength(commands.length);
    expect(changes.every((change) => !rawCommandLabels.has(change.label))).toBe(
      true,
    );
  });

  it('preserves details needed by rich command messages', () => {
    const changes = reconstructChangesFromCommands(commands);

    expect(changes[3]).toMatchObject({
      nodeId: NODE_1,
      targetFrameId: NODE_2,
    });
    expect(changes[3].label).toMatch(/^Moved into frame: /);
    expect(changes[8]).toEqual(
      expect.objectContaining({ label: 'Disconnected', edgeId: EDGE_1 }),
    );
    expect(changes[6]).toMatchObject({
      operation: 'reordered',
      detail: 'top',
      count: 1,
    });
    expect(changes[9]).toMatchObject({ operation: 'edgeStyle', count: 1 });
    expect(changes[10]).toMatchObject({
      operation: 'aligned',
      detail: 'left',
      count: 2,
    });
    expect(changes[12]).toMatchObject({
      nodeId: NODE_2,
      frameLayout: { mode: 'column', gridCount: 2 },
    });
  });
});
