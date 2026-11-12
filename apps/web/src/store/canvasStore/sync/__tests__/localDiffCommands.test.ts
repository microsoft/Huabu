// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  commandsForLocalDiff,
  commandsForStateDiff,
} from '../localDiffCommands';

import type { UnitNode } from '../propertyUnits';

const x: UnitNode = {
  id: 'x',
  type: 'note',
  position: { x: 0, y: 0 },
  style: { width: 300, height: 200 },
  data: { label: 'X', content: 'body', style: { accent: 'white' } },
};
const y: UnitNode = {
  id: 'y',
  type: 'note',
  position: { x: 0, y: 300 },
  style: { width: 300 },
  data: {},
};
const frame: UnitNode = {
  id: 'f',
  type: 'frame',
  position: { x: 0, y: 0 },
  data: {},
};
const content = (unit: string) =>
  unit === 'data.content' || unit === 'data.label';

describe('commandsForLocalDiff', () => {
  it('reads geometry and data changes back as commands', () => {
    const next = [
      {
        ...x,
        position: { x: 40, y: 10 },
        style: { width: 320, height: 240 },
        data: {
          label: 'X',
          content: 'body',
          pinned: true,
          style: { accent: 'blue', fontSize: 18 },
        },
      },
      y,
    ];
    expect(commandsForLocalDiff([x, y], next)).toEqual({
      commands: [
        {
          type: 'SET_NODE_GEOMETRY',
          items: [
            {
              nodeId: 'x',
              position: { x: 40, y: 10 },
              size: { width: 320, height: 240 },
            },
          ],
        },
        {
          type: 'MERGE_NODE_DATA',
          patches: [
            {
              nodeId: 'x',
              patch: { pinned: true, style: { accent: 'blue', fontSize: 18 } },
            },
          ],
        },
      ],
      uncovered: [],
    });
  });

  it('sends a width without a height for a node whose height is renderer-owned', () => {
    const next = [x, { ...y, style: { width: 360 } }];
    expect(commandsForLocalDiff([x, y], next).commands).toEqual([
      {
        type: 'SET_NODE_GEOMETRY',
        items: [{ nodeId: 'y', size: { width: 360 } }],
      },
    ]);
  });

  it('leaves out fields another writer saves', () => {
    const next = [
      {
        ...x,
        data: { label: 'Renamed', content: 'new', style: { accent: 'white' } },
      },
      y,
    ];
    expect(commandsForLocalDiff([x, y], next, content)).toEqual({
      commands: [],
      uncovered: [],
    });
  });

  it('reports what it cannot express instead of guessing', () => {
    const next = [{ ...x, zIndex: 4, data: { content: 'body', style: {} } }];
    const result = commandsForLocalDiff([x], next);
    expect(result.uncovered.sort()).toEqual(
      ['x:data.label', 'x:data.style.accent', 'x:node.zIndex'].sort(),
    );
  });

  it('is empty for the same list and for untouched nodes', () => {
    expect(commandsForLocalDiff([x, y], [x, y]).commands).toEqual([]);
    expect(
      commandsForLocalDiff([x], [{ ...x, selected: true }]).commands,
    ).toEqual([]);
  });
});

describe('commandsForStateDiff', () => {
  const edge = { id: 'e', source: 'x', target: 'y' };

  it('deletes nodes the target no longer has, and only disconnects surviving ends', () => {
    const other = { id: 'e2', source: 'x', target: 'f' };
    const result = commandsForStateDiff(
      { nodes: [x, y, frame], edges: [edge, other] },
      { nodes: [x, frame], edges: [] },
    );
    expect(result).toEqual({
      commands: [
        { type: 'DISCONNECT_EDGES', edges: ['e2'] },
        { type: 'DELETE_NODES', nodeIds: ['y'] },
      ],
      uncovered: [],
    });
  });

  it('cannot bring a node back', () => {
    const result = commandsForStateDiff(
      { nodes: [x], edges: [] },
      { nodes: [x, y], edges: [] },
    );
    expect(result.uncovered).toEqual(['y:existence']);
  });

  it('reparents, then states the final position', () => {
    const inside = { ...y, parentId: 'f', position: { x: 20, y: 30 } };
    expect(
      commandsForStateDiff(
        { nodes: [frame, x, y], edges: [] },
        { nodes: [frame, x, inside], edges: [] },
      ).commands,
    ).toEqual([
      { type: 'SET_NODE_PARENT', nodeIds: ['y'], parentId: 'f' },
      {
        type: 'SET_NODE_GEOMETRY',
        items: [{ nodeId: 'y', position: { x: 20, y: 30 } }],
      },
    ]);
    expect(
      commandsForStateDiff(
        { nodes: [frame, x, inside], edges: [] },
        { nodes: [frame, x, y], edges: [] },
      ).commands[0],
    ).toEqual({ type: 'SET_NODE_PARENT', nodeIds: ['y'], parentId: null });
  });

  it('moves only the siblings that are out of place', () => {
    const a: UnitNode = { id: 'a', data: {} };
    const b: UnitNode = { id: 'b', data: {} };
    const c: UnitNode = { id: 'c', data: {} };
    const d: UnitNode = { id: 'd', data: {} };
    expect(
      commandsForStateDiff(
        { nodes: [a, b, c, d], edges: [] },
        { nodes: [a, d, b, c], edges: [] },
      ).commands,
    ).toEqual([{ type: 'REORDER_NODES', nodeIds: ['d'], to: { after: 'a' } }]);
    expect(
      commandsForStateDiff(
        { nodes: [a, b, c, d], edges: [] },
        { nodes: [c, a, b, d], edges: [] },
      ).commands,
    ).toEqual([{ type: 'REORDER_NODES', nodeIds: ['c'], to: { before: 'a' } }]);
  });

  it('connects an added edge under its id', () => {
    expect(
      commandsForStateDiff(
        { nodes: [x, y], edges: [] },
        { nodes: [x, y], edges: [edge] },
      ).commands,
    ).toEqual([
      { type: 'CONNECT_NODES', edges: [{ id: 'e', source: 'x', target: 'y' }] },
    ]);
  });
});
