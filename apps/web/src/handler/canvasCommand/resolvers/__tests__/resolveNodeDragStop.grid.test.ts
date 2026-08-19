// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  applyGridLayout,
  computeFrameFit,
  executeCanvasCommands,
} from '@huabu/shared/canvas-engine';

import { resolveUiIntent } from '../../uiIntent';

import type { UiResolverState } from '../../uiIntent';
import type { CanvasCommand } from '@huabu/shared';
import type { Node, XYPosition } from '@xyflow/react';

const CHILD_SIZE = { width: 80, height: 40 };

function makeFrame(): Node {
  return {
    id: 'frame',
    type: 'frame',
    position: { x: 0, y: 0 },
    data: { layoutMode: 'grid', gridCount: 2, sizing: 'manual' },
    style: { width: 240, height: 180 },
    measured: { width: 240, height: 180 },
  } as Node;
}

function makeChild(
  id: string,
  frameColumn: number,
  frameRow: number,
  parentId: string | undefined = 'frame',
): Node {
  return {
    id,
    type: 'text',
    parentId,
    position: { x: 0, y: 0 },
    data: { frameColumn, frameRow },
    style: CHILD_SIZE,
    measured: CHILD_SIZE,
  } as Node;
}

function layoutScene(nodes: Node[]): {
  nodes: Node[];
  positions: Map<string, XYPosition>;
  rowTracks: Array<{ top: number; height: number }>;
} {
  const layout = applyGridLayout(nodes, 'frame', 2);
  if (!layout) throw new Error('Grid fixture did not produce a layout');
  return {
    nodes: nodes.map((node) => {
      const position = layout.childPositions.get(node.id);
      return position ? { ...node, position } : node;
    }),
    positions: layout.childPositions,
    rowTracks: layout.rowTracks ?? [],
  };
}

function mergedPatches(
  commands: CanvasCommand[],
): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const command of commands) {
    if (command.type !== 'MERGE_NODE_DATA') continue;
    for (const item of command.patches) {
      result.set(item.nodeId, { ...result.get(item.nodeId), ...item.patch });
    }
  }
  return result;
}

function state(nodes: Node[]): UiResolverState {
  return { nodes, edges: [] };
}

describe('resolveNodeDragStop Grid cells', () => {
  it('freezes nested Frames for external drops unless entry is explicit', () => {
    const outer = {
      id: 'outer',
      type: 'frame',
      position: { x: 0, y: 0 },
      data: { sizing: 'manual' },
      style: { width: 500, height: 500 },
      measured: { width: 500, height: 500 },
    } as Node;
    const inner = {
      id: 'inner',
      type: 'frame',
      parentId: 'outer',
      position: { x: 50, y: 50 },
      data: { sizing: 'manual' },
      style: { width: 200, height: 200 },
      measured: { width: 200, height: 200 },
    } as Node;
    const dragged = {
      id: 'dragged',
      type: 'note',
      position: { x: 140, y: 140 },
      data: {},
      style: { width: 100, height: 100 },
      measured: { width: 100, height: 100 },
    } as Node;
    const pointerFlowPosition = { x: 160, y: 160 };

    const resolveParent = (allowNestedFrameEntry: boolean) => {
      const resolution = resolveUiIntent(
        {
          type: 'NODE_DRAG_STOP',
          draggedNodeIds: ['dragged'],
          pointerFlowPosition,
          allowNestedFrameEntry,
        },
        state([outer, inner, dragged]),
      );
      return resolution.commands.find(
        (command) => command.type === 'SET_NODE_PARENT',
      );
    };

    expect(resolveParent(false)).toMatchObject({ parentId: 'outer' });
    expect(resolveParent(true)).toMatchObject({ parentId: 'inner' });
  });

  it('commits a cached upward move from an inner Frame to its outer ancestor', () => {
    const outer = {
      id: 'outer',
      type: 'frame',
      position: { x: 0, y: 0 },
      data: { sizing: 'manual' },
      style: { width: 500, height: 500 },
      measured: { width: 500, height: 500 },
    } as Node;
    const inner = {
      id: 'inner',
      type: 'frame',
      parentId: 'outer',
      position: { x: 50, y: 50 },
      data: { sizing: 'manual' },
      style: { width: 200, height: 200 },
      measured: { width: 200, height: 200 },
    } as Node;
    const dragged = {
      id: 'dragged',
      type: 'note',
      parentId: 'inner',
      position: { x: -40, y: -40 },
      data: {},
      style: { width: 100, height: 100 },
      measured: { width: 100, height: 100 },
    } as Node;

    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: ['dragged'],
        pointerFlowPosition: { x: 30, y: 30 },
        cachedDecisions: new Map([
          ['dragged', { unframe: true, enterFrameId: 'outer' }],
        ]),
      },
      state([outer, inner, dragged]),
    );

    expect(
      resolution.commands.find((command) => command.type === 'SET_NODE_PARENT'),
    ).toMatchObject({ nodeIds: ['dragged'], parentId: 'outer' });
  });

  it('fits a Hug outer Frame after a node moves up from its inner Frame', () => {
    const outer = {
      id: 'outer',
      type: 'frame',
      position: { x: 0, y: 0 },
      data: { sizing: 'hug' },
      style: { width: 500, height: 500 },
      measured: { width: 500, height: 500 },
    } as Node;
    const inner = {
      id: 'inner',
      type: 'frame',
      parentId: 'outer',
      position: { x: 100, y: 100 },
      data: { sizing: 'manual' },
      style: { width: 200, height: 200 },
      measured: { width: 200, height: 200 },
    } as Node;
    const dragged = {
      id: 'dragged',
      type: 'note',
      parentId: 'inner',
      position: { x: -80, y: -80 },
      data: {},
      style: { width: 100, height: 100 },
      measured: { width: 100, height: 100 },
    } as Node;
    const nodes = [outer, inner, dragged];
    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: ['dragged'],
        pointerFlowPosition: { x: 30, y: 30 },
        cachedDecisions: new Map([
          ['dragged', { unframe: true, enterFrameId: 'outer' }],
        ]),
      },
      state(nodes),
    );
    const committed = executeCanvasCommands(
      { source: 'ui', commands: resolution.commands },
      { nodes, edges: [], canvasId: 'canvas' },
    ).writeResult.nodes;
    const committedOuter = committed.find((node) => node.id === 'outer');
    const stableFit = computeFrameFit(committed, 'outer');

    expect(committed.find((node) => node.id === 'dragged')?.parentId).toBe(
      'outer',
    );
    expect(committedOuter?.position).toEqual(stableFit?.position);
    expect(committedOuter?.style).toMatchObject({
      width: stableFit?.width,
      height: stableFit?.height,
    });
  });

  it('stabilizes a Hug grid height when a node moves up across three Frame levels', () => {
    const outer = {
      id: 'outer',
      type: 'frame',
      position: { x: 0, y: 0 },
      data: { layoutMode: 'grid', gridCount: 2, sizing: 'hug' },
      style: { width: 600, height: 300 },
      measured: { width: 600, height: 300 },
    } as Node;
    const middle = {
      id: 'middle',
      type: 'frame',
      parentId: 'outer',
      position: { x: 30, y: 30 },
      data: { frameColumn: 0, frameRow: 0, sizing: 'manual' },
      style: { width: 240, height: 200 },
      measured: { width: 240, height: 200 },
    } as Node;
    const outerPeer = {
      id: 'outer-peer',
      type: 'note',
      parentId: 'outer',
      position: { x: 300, y: 30 },
      data: { frameColumn: 1, frameRow: 0 },
      style: { width: 120, height: 80 },
      measured: { width: 120, height: 80 },
    } as Node;
    const inner = {
      id: 'inner',
      type: 'frame',
      parentId: 'middle',
      position: { x: 20, y: 20 },
      data: { sizing: 'manual' },
      style: { width: 180, height: 140 },
      measured: { width: 180, height: 140 },
    } as Node;
    const dragged = {
      id: 'dragged',
      type: 'note',
      parentId: 'inner',
      position: { x: 20, y: 20 },
      data: {},
      style: { width: 100, height: 80 },
      measured: { width: 100, height: 80 },
    } as Node;
    const initial = [outer, middle, outerPeer, inner, dragged];
    const initialLayout = applyGridLayout(initial, 'outer', 2);
    if (!initialLayout) throw new Error('Outer grid fixture did not resolve');
    const nodes = initial.map((node) => {
      const position = initialLayout.childPositions.get(node.id);
      return position ? { ...node, position } : node;
    });
    const outerHeight = initialLayout.frameSize.height;

    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: ['dragged'],
        pointerFlowPosition: { x: 80, y: outerHeight + 20 },
        cachedDecisions: new Map([
          ['dragged', { unframe: true, enterFrameId: 'outer' }],
        ]),
      },
      state(nodes),
    );
    const committed = executeCanvasCommands(
      { source: 'ui', commands: resolution.commands },
      { nodes, edges: [], canvasId: 'canvas' },
    ).writeResult.nodes;
    const committedOuter = committed.find((node) => node.id === 'outer');
    const stableLayout = applyGridLayout(committed, 'outer', 2);

    expect(committed.find((node) => node.id === 'dragged')?.parentId).toBe(
      'outer',
    );
    expect(committedOuter?.style?.height).toBe(stableLayout?.frameSize.height);
  });

  it('keeps a Hug child Frame on its outer structured track after entry', () => {
    const outer = {
      id: 'outer',
      type: 'frame',
      position: { x: 0, y: 0 },
      data: { layoutMode: 'grid', gridCount: 2, sizing: 'manual' },
      style: { width: 600, height: 300 },
      measured: { width: 600, height: 300 },
    } as Node;
    const peer = {
      id: 'peer',
      type: 'frame',
      parentId: 'outer',
      position: { x: 0, y: 0 },
      data: { frameColumn: 0, frameRow: 0, sizing: 'manual' },
      style: { width: 180, height: 140 },
      measured: { width: 180, height: 140 },
    } as Node;
    const target = {
      id: 'target',
      type: 'frame',
      parentId: 'outer',
      position: { x: 0, y: 0 },
      data: { frameColumn: 1, frameRow: 0, sizing: 'hug' },
      style: { width: 180, height: 140 },
      measured: { width: 180, height: 140 },
    } as Node;
    const initialLayout = applyGridLayout([outer, peer, target], 'outer', 2);
    const targetStart = initialLayout?.childPositions.get('target');
    if (!initialLayout || !targetStart) {
      throw new Error('Nested Frame fixture did not produce a layout');
    }
    const laidOut = [outer, peer, target].map((node) => {
      const position = initialLayout.childPositions.get(node.id);
      return position ? { ...node, position } : node;
    });
    const dragged = {
      id: 'dragged',
      type: 'note',
      position: {
        x: targetStart.x + outer.position.x + 120,
        y: targetStart.y + outer.position.y + 80,
      },
      data: {},
      style: { width: 100, height: 80 },
      measured: { width: 100, height: 80 },
    } as Node;
    const nodes = [...laidOut, dragged];

    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: ['dragged'],
        pointerFlowPosition: {
          x: targetStart.x + outer.position.x + 150,
          y: targetStart.y + outer.position.y + 100,
        },
        cachedDecisions: new Map([
          ['dragged', { unframe: false, enterFrameId: 'target' }],
        ]),
      },
      state(nodes),
    );
    const committed = executeCanvasCommands(
      { source: 'ui', commands: resolution.commands },
      { nodes, edges: [], canvasId: 'canvas' },
    ).writeResult.nodes;
    const expected = applyGridLayout(committed, 'outer', 2)?.childPositions.get(
      'target',
    );
    const committedTarget = committed.find((node) => node.id === 'target');

    expect(committedTarget?.position).toEqual(expected);
  });

  it('moves into an empty later cell without touching earlier rows', () => {
    const scene = layoutScene([
      makeFrame(),
      makeChild('row-0', 1, 0),
      makeChild('row-1', 1, 1),
      makeChild('dragged', 1, 2),
      makeChild('source-row-peer', 0, 2),
      makeChild('target-row-peer', 0, 3),
    ]);
    const targetTrack = scene.rowTracks[3];
    if (!targetTrack) throw new Error('Target row fixture is missing');
    const columnPosition = scene.positions.get('dragged');
    if (!columnPosition) throw new Error('Dragged fixture is missing');
    const liveNodes = scene.nodes.map((node) =>
      node.id === 'dragged'
        ? {
            ...node,
            position: {
              ...node.position,
              y: targetTrack.top,
            },
          }
        : node,
    );

    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: ['dragged'],
        pointerFlowPosition: {
          x: columnPosition.x + CHILD_SIZE.width / 2,
          y: targetTrack.top + targetTrack.height / 2,
        },
        cachedDecisions: new Map([
          ['dragged', { unframe: false, enterFrameId: null }],
        ]),
      },
      state(liveNodes),
    );
    const patches = mergedPatches(resolution.commands);
    const geometryNodeIds = resolution.commands.flatMap((command) =>
      command.type === 'SET_NODE_GEOMETRY'
        ? command.items.map((item) => item.nodeId)
        : [],
    );

    expect(patches.get('dragged')).toMatchObject({ frameRow: 3 });
    expect(patches.has('row-0')).toBe(false);
    expect(patches.has('row-1')).toBe(false);
    expect(patches.has('source-row-peer')).toBe(false);
    expect(patches.has('target-row-peer')).toBe(false);
    expect(geometryNodeIds).not.toContain('row-0');
    expect(geometryNodeIds).not.toContain('row-1');
    expect(geometryNodeIds).not.toContain('source-row-peer');
    expect(geometryNodeIds).not.toContain('target-row-peer');
  });

  it('compacts only later rows when the source row becomes empty', () => {
    const scene = layoutScene([
      makeFrame(),
      makeChild('before', 0, 0),
      makeChild('dragged', 1, 1),
      makeChild('after', 0, 2),
      makeChild('target-row-peer', 0, 3),
    ]);
    const targetTrack = scene.rowTracks[3];
    const columnPosition = scene.positions.get('dragged');
    if (!targetTrack || !columnPosition) {
      throw new Error('Grid compaction fixture is missing');
    }

    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: ['dragged'],
        pointerFlowPosition: {
          x: columnPosition.x + CHILD_SIZE.width / 2,
          y: targetTrack.top + targetTrack.height / 2,
        },
        cachedDecisions: new Map([
          ['dragged', { unframe: false, enterFrameId: null }],
        ]),
      },
      state(scene.nodes),
    );
    const patches = mergedPatches(resolution.commands);

    expect(patches.has('before')).toBe(false);
    expect(patches.get('after')).toMatchObject({ frameRow: 1 });
    expect(patches.get('target-row-peer')).toMatchObject({ frameRow: 2 });
    expect(patches.get('dragged')).toMatchObject({ frameRow: 2 });
  });

  it('swaps two children when an internal drag targets an occupied cell', () => {
    const scene = layoutScene([
      makeFrame(),
      makeChild('dragged', 0, 0),
      makeChild('occupant', 1, 1),
    ]);
    const target = scene.positions.get('occupant');
    if (!target) throw new Error('Target fixture is missing');

    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: ['dragged'],
        pointerFlowPosition: {
          x: target.x + CHILD_SIZE.width / 2,
          y: target.y + CHILD_SIZE.height / 2,
        },
        cachedDecisions: new Map([
          ['dragged', { unframe: false, enterFrameId: null }],
        ]),
      },
      state(scene.nodes),
    );
    const patches = mergedPatches(resolution.commands);

    expect(patches.get('dragged')).toMatchObject({
      frameColumn: 1,
      frameRow: 1,
    });
    expect(patches.get('occupant')).toMatchObject({
      frameColumn: 0,
      frameRow: 0,
    });
  });

  it('reorders sibling frames instead of nesting one into the other', () => {
    const scene = layoutScene([
      makeFrame(),
      { ...makeChild('dragged', 0, 0), type: 'frame' },
      { ...makeChild('occupant', 1, 0), type: 'frame' },
    ]);
    const target = scene.positions.get('occupant');
    if (!target) throw new Error('Target fixture is missing');
    const liveNodes = scene.nodes.map((node) =>
      node.id === 'dragged' ? { ...node, position: target } : node,
    );

    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: ['dragged'],
        pointerFlowPosition: {
          x: target.x + CHILD_SIZE.width / 2,
          y: target.y + CHILD_SIZE.height / 2,
        },
      },
      state(liveNodes),
    );
    const patches = mergedPatches(resolution.commands);
    const parentCommands = resolution.commands.filter(
      (command) => command.type === 'SET_NODE_PARENT',
    );

    expect(parentCommands).toHaveLength(0);
    expect(patches.get('dragged')).toMatchObject({ frameColumn: 1 });
    expect(patches.get('occupant')).toMatchObject({ frameColumn: 0 });
  });

  it('nests into a sibling frame when Cmd or Ctrl overrides reordering', () => {
    const scene = layoutScene([
      makeFrame(),
      { ...makeChild('dragged', 0, 0), type: 'frame' },
      { ...makeChild('occupant', 1, 0), type: 'frame' },
    ]);
    const target = scene.positions.get('occupant');
    if (!target) throw new Error('Target fixture is missing');
    const liveNodes = scene.nodes.map((node) =>
      node.id === 'dragged' ? { ...node, position: target } : node,
    );

    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: ['dragged'],
        pointerFlowPosition: {
          x: target.x + CHILD_SIZE.width / 2,
          y: target.y + CHILD_SIZE.height / 2,
        },
        allowNestedFrameEntry: true,
      },
      state(liveNodes),
    );
    const parentCommand = resolution.commands.find(
      (command) => command.type === 'SET_NODE_PARENT',
    );

    expect(parentCommand).toMatchObject({
      nodeIds: ['dragged'],
      parentId: 'occupant',
    });
  });

  it('reorders a regular node instead of nesting it into a sibling frame', () => {
    const scene = layoutScene([
      makeFrame(),
      makeChild('dragged', 0, 0),
      { ...makeChild('occupant', 1, 0), type: 'frame' },
    ]);
    const target = scene.positions.get('occupant');
    if (!target) throw new Error('Target fixture is missing');
    const liveNodes = scene.nodes.map((node) =>
      node.id === 'dragged' ? { ...node, position: target } : node,
    );

    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: ['dragged'],
        pointerFlowPosition: {
          x: target.x + CHILD_SIZE.width / 2,
          y: target.y + CHILD_SIZE.height / 2,
        },
      },
      state(liveNodes),
    );
    const patches = mergedPatches(resolution.commands);
    const parentCommands = resolution.commands.filter(
      (command) => command.type === 'SET_NODE_PARENT',
    );

    expect(parentCommands).toHaveLength(0);
    expect(patches.get('dragged')).toMatchObject({ frameColumn: 1 });
    expect(patches.get('occupant')).toMatchObject({ frameColumn: 0 });
  });

  it('nests a regular node into a sibling frame with Cmd or Ctrl', () => {
    const scene = layoutScene([
      makeFrame(),
      makeChild('dragged', 0, 0),
      { ...makeChild('occupant', 1, 0), type: 'frame' },
    ]);
    const target = scene.positions.get('occupant');
    if (!target) throw new Error('Target fixture is missing');
    const liveNodes = scene.nodes.map((node) =>
      node.id === 'dragged' ? { ...node, position: target } : node,
    );

    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: ['dragged'],
        pointerFlowPosition: {
          x: target.x + CHILD_SIZE.width / 2,
          y: target.y + CHILD_SIZE.height / 2,
        },
        allowNestedFrameEntry: true,
      },
      state(liveNodes),
    );
    const parentCommand = resolution.commands.find(
      (command) => command.type === 'SET_NODE_PARENT',
    );

    expect(parentCommand).toMatchObject({
      nodeIds: ['dragged'],
      parentId: 'occupant',
    });
  });

  it('inserts a row when an external child targets an occupied cell', () => {
    const scene = layoutScene([
      makeFrame(),
      makeChild('occupant', 1, 0),
      makeChild('next-row', 0, 1),
    ]);
    const target = scene.positions.get('occupant');
    if (!target) throw new Error('Target fixture is missing');
    const external = {
      ...makeChild('dragged', 0, 0, undefined),
      parentId: undefined,
      position: target,
      data: {},
    };

    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: ['dragged'],
        pointerFlowPosition: {
          x: target.x + CHILD_SIZE.width / 2,
          y: target.y + CHILD_SIZE.height / 2,
        },
        cachedDecisions: new Map([
          ['dragged', { unframe: false, enterFrameId: 'frame' }],
        ]),
      },
      state([...scene.nodes, external]),
    );
    const patches = mergedPatches(resolution.commands);

    expect(patches.get('dragged')).toMatchObject({
      frameColumn: 1,
      frameRow: 0,
    });
    expect(patches.get('occupant')).toMatchObject({ frameRow: 1 });
    expect(patches.get('next-row')).toMatchObject({ frameRow: 2 });
  });

  it('opens a row when an internal drag aims between two rows', () => {
    // Without an `insert-new` target on the row axis this drop could
    // only resolve to one of the neighbouring rows, so a grid could be
    // permuted but never grown along Y.
    const scene = layoutScene([
      makeFrame(),
      makeChild('top-left', 0, 0),
      makeChild('top-right', 1, 0),
      makeChild('middle', 0, 1),
      makeChild('dragged', 1, 2),
    ]);
    const columnPosition = scene.positions.get('dragged');
    const [firstRow, secondRow] = scene.rowTracks;
    if (!columnPosition || !firstRow || !secondRow) {
      throw new Error('Row gutter fixture is missing');
    }

    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: ['dragged'],
        pointerFlowPosition: {
          x: columnPosition.x + CHILD_SIZE.width / 2,
          y: (firstRow.top + firstRow.height + secondRow.top) / 2,
        },
        cachedDecisions: new Map([
          ['dragged', { unframe: false, enterFrameId: null }],
        ]),
      },
      state(scene.nodes),
    );
    const patches = mergedPatches(resolution.commands);

    expect(patches.get('dragged')).toMatchObject({ frameRow: 1 });
    expect(patches.get('middle')).toMatchObject({ frameRow: 2 });
    expect(patches.has('top-left')).toBe(false);
    expect(patches.has('top-right')).toBe(false);
  });

  // A drop that leaves a column empty compacts the grid, and the track
  // count is what re-interprets every cell in it. `SET_FRAME_LAYOUT`
  // re-deals cells in reading order when it is handed a count on its
  // own — the right answer for the toolbar, and the wrong one here,
  // where the drop already knows every cell. Executing the batch is the
  // only way to catch the disagreement: the emitted patches look
  // correct in isolation.
  it('commits the planned cells when the drop empties a column', () => {
    const scene = layoutScene([
      makeFrame(),
      makeChild('dragged', 0, 0),
      makeChild('top', 1, 0),
      makeChild('bottom', 1, 1),
    ]);
    // Aim below the last occupied cell of the surviving column.
    const bottom = scene.positions.get('bottom');
    if (!bottom) throw new Error('Bottom fixture is missing');
    const target = {
      x: bottom.x + CHILD_SIZE.width / 2,
      y: bottom.y + CHILD_SIZE.height * 1.5,
    };

    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: ['dragged'],
        pointerFlowPosition: target,
        cachedDecisions: new Map([
          ['dragged', { unframe: false, enterFrameId: null }],
        ]),
      },
      state(scene.nodes),
    );

    const committed = executeCanvasCommands(
      { source: 'ui', commands: resolution.commands },
      { nodes: scene.nodes, edges: [], canvasId: 'canvas' },
    );
    const cells = new Map(
      committed.writeResult.nodes
        .filter((node) => node.parentId === 'frame')
        .map((node) => {
          const data = node.data as { frameColumn?: number; frameRow?: number };
          return [node.id, `${data.frameColumn}:${data.frameRow}`];
        }),
    );

    // The column the drag vacated is gone, so everything lives in
    // column 0 — each on its own row, exactly as the drag showed.
    expect(cells.get('top')).toBe('0:0');
    expect(cells.get('bottom')).toBe('0:1');
    expect(cells.get('dragged')).toBe('0:2');
    expect(new Set(cells.values()).size).toBe(cells.size);
  });
});
