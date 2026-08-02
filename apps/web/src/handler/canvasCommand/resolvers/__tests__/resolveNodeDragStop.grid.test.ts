import { describe, expect, it } from 'vitest';

import {
  applyGridLayout,
  executeCanvasCommands,
} from '@sediment/shared/canvas-engine';

import { resolveUiIntent } from '../../uiIntent';

import type { UiResolverState } from '../../uiIntent';
import type { CanvasCommand } from '@sediment/shared';
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
