// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  executeCanvasCommands,
  rerouteAllEdges,
  solveStructuredFrameLayout,
} from '@huabu/shared/canvas-engine';

const api = vi.hoisted(() => ({
  putCanvas: vi.fn(),
  postCanvasEvents: vi.fn(),
}));
vi.mock('../api', async (actual) => ({
  ...(await actual<typeof apiModule>()),
  ...api,
}));
vi.mock('../api/canvas', async (actual) => ({
  ...(await actual<typeof canvasApiModule>()),
  ...api,
}));

import { resumeHeightCommits } from '@/components/Nodes/shared/height/commitSuspension';
import { resolveUiIntent } from '@/handler/canvasCommand/uiIntent';

import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore from './canvasStore';
import { useGesturePreviewStore } from './gesturePreviewStore';

import type * as apiModule from '../api';
import type * as canvasApiModule from '../api/canvas';
import type { Edge, Node, ReactFlowInstance, XYPosition } from '@xyflow/react';

const state = () => useCanvasStore.getState();
const right = { sourceHandle: 'right-source', targetHandle: 'left-target' };
const down = { sourceHandle: 'bottom-source', targetHandle: 'top-target' };
const up = { sourceHandle: 'top-source', targetHandle: 'bottom-target' };
const left = { sourceHandle: 'left-source', targetHandle: 'right-target' };

function note(
  id: string,
  x: number,
  y: number,
  extra: Partial<Node> = {},
): Node {
  return {
    id,
    type: 'note',
    position: { x, y },
    style: { width: 100, height: 100 },
    data: { heightMode: 'fixed' },
    ...extra,
  };
}

function edge(source: string, target: string): Edge {
  return { id: `edge-${source}-${target}`, source, target };
}

function seed(nodes: Node[], edges: Edge[]) {
  state()._setStateNoAutosave({ nodes, edges: rerouteAllEdges(nodes, edges) });
}

function node(id: string): Node {
  const found = state().nodes.find((n) => n.id === id);
  if (!found) throw new Error(`Missing node fixture: ${id}`);
  return found;
}

// Only transport is mocked. Exercise the actual RF callbacks, resolver,
// shared post-effects, history, and debounced structure persistence.
function start(ids: string[]) {
  const nodes = ids.map(node);
  state().onNodeDragStart(
    new MouseEvent('mousedown', { altKey: true }),
    nodes[0],
    nodes,
  );
}

function move(id: string, position: XYPosition, dragging: boolean) {
  state().onNodesChange([{ type: 'position', id, position, dragging }]);
}

function stop(ids: string[]) {
  const nodes = ids.map(node);
  state().onNodeDragStop(new MouseEvent('mouseup'), nodes[0], nodes);
}

function drag(id: string, position: XYPosition) {
  start([id]);
  move(id, position, true);
  move(id, position, false);
  stop([id]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  canvasHistoryManager.activate('routing-canvas', true);
  state()._setStateNoAutosave({
    nodes: [],
    edges: [],
    canvasId: 'routing-canvas',
    canvasTitle: 'Routing',
    version: 1,
    isLoading: false,
    isSaving: false,
    pendingSave: false,
    versionConflict: false,
    versionConflictServerVersion: null,
    rfInstance: null,
    canvasWrapper: null,
  });
  api.putCanvas.mockResolvedValue({ canvasId: 'routing-canvas', version: 2 });
  api.postCanvasEvents.mockResolvedValue({ success: true });
});

afterEach(() => {
  state().endActiveDragSession();
  resumeHeightCommits('node-drag');
  canvasHistoryManager.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('edge routing after real node drags', () => {
  it.each(['column', 'row'] as const)(
    'uses the release track when the next %s preview frame has not run',
    (axis) => {
      const field = axis === 'column' ? 'frameColumn' : 'frameRow';
      const nodes = [
        note('frame', 0, 0, {
          type: 'frame',
          data: { sizing: 'manual', layoutMode: axis, gridCount: 2 },
          style: { width: 800, height: 800 },
        }),
        ...Array.from({ length: 4 }, (_, index) =>
          note(`child-${index}`, 20 + index * 120, 64 + index * 120, {
            parentId: 'frame',
            data: { heightMode: 'fixed', [field]: Math.floor(index / 2) },
          }),
        ),
      ];
      const layout = solveStructuredFrameLayout(nodes, 'frame');
      if (!layout) throw new Error('Missing structured layout');
      seed(
        nodes.map((entry) => ({
          ...entry,
          position: layout.childPositions.get(entry.id) ?? entry.position,
        })),
        [],
      );
      const instance: Pick<
        ReactFlowInstance,
        'screenToFlowPosition' | 'getZoom'
      > = {
        screenToFlowPosition: (point) => point,
        getZoom: () => 1,
      };
      state()._setStateNoAutosave({
        rfInstance: instance as ReactFlowInstance,
      });
      const first = node('child-0').position;
      const second = node('child-2').position;
      const event = (type: string, position: XYPosition) =>
        new MouseEvent(type, {
          clientX: position.x + 40,
          clientY: position.y + 30,
          altKey: true,
        });
      start(['child-1']);
      move('child-1', first, true);
      state().onNodeDrag(event('mousemove', first), node('child-1'), [
        node('child-1'),
      ]);
      vi.advanceTimersToNextFrame();
      expect(
        useGesturePreviewStore.getState().structuredDropPreview?.masonry
          ?.target,
      ).toEqual({ kind: 'into-existing', slot: 0 });
      move('child-1', second, true);
      state().onNodeDrag(event('mousemove', second), node('child-1'), [
        node('child-1'),
      ]);
      expect(
        useGesturePreviewStore.getState().structuredDropPreview?.masonry
          ?.target,
      ).toEqual({ kind: 'into-existing', slot: 0 });
      move('child-1', second, false);
      state().onNodeDragStop(event('mouseup', second), node('child-1'), [
        node('child-1'),
      ]);
      expect(node('child-1').data[field]).toBe(1);
      expect(
        useGesturePreviewStore.getState().structuredDropPreview,
      ).toBeNull();
      vi.advanceTimersToNextFrame();
      expect(
        useGesturePreviewStore.getState().structuredDropPreview,
      ).toBeNull();
    },
  );

  it('reselects ports on release even when a free move applies no commands', async () => {
    seed([note('s', 0, 0), note('t', 300, 0)], [edge('s', 't')]);
    const before = state().edges;
    start(['t']);
    move('t', { x: 0, y: 300 }, true);
    expect(state().edges).toBe(before);
    move('t', { x: 0, y: 300 }, false);
    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: ['t'],
      },
      state(),
    );
    const result = executeCanvasCommands(
      { commands: resolution.commands },
      state(),
    );
    expect(result.commandResults.some((command) => command.applied)).toBe(
      false,
    );
    stop(['t']);
    expect(state().edges[0]).toMatchObject(down);

    await vi.advanceTimersByTimeAsync(2000);
    expect(api.putCanvas).toHaveBeenCalledOnce();
    expect(api.putCanvas).toHaveBeenCalledWith(
      'routing-canvas',
      expect.objectContaining({
        state: expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: 't',
              position: { x: 0, y: 300 },
            }),
          ]),
          edges: [expect.objectContaining(down)],
        }),
      }),
      expect.anything(),
    );
  });

  it('adapts on successive moves to each side of the other node', () => {
    seed([note('s', 0, 0), note('t', 300, 0)], [edge('s', 't')]);
    for (const [position, handles] of [
      [{ x: 0, y: 300 }, down],
      [{ x: -300, y: 0 }, left],
      [{ x: 0, y: -300 }, up],
      [{ x: 300, y: 0 }, right],
    ] as const) {
      drag('t', position);
      expect(state().edges[0]).toMatchObject(handles);
    }
  });

  it('recalculates all branches when the common parent is moved below the row', () => {
    seed(
      [
        note('hub', 300, 0),
        note('a', 0, 200),
        note('b', 300, 200),
        note('c', 600, 200),
      ],
      ['a', 'b', 'c'].map((id) => edge('hub', id)),
    );
    for (const e of state().edges) expect(e).toMatchObject(down);
    drag('hub', { x: 300, y: 500 });
    for (const e of state().edges) expect(e).toMatchObject(up);
  });

  it('recalculates edges of descendants when only their containing frame moves', () => {
    seed(
      [
        note('frame', 0, 0, {
          type: 'frame',
          data: { sizing: 'manual' },
          style: { width: 200, height: 200 },
        }),
        note('s', 50, 50, { parentId: 'frame' }),
        note('t', 400, 50),
      ],
      [edge('s', 't')],
    );
    expect(state().edges[0]).toMatchObject(right);
    drag('frame', { x: 350, y: -350 });
    expect(node('s').position).toEqual({ x: 50, y: 50 });
    expect(node('s').parentId).toBe('frame');
    expect(state().edges[0]).toMatchObject(down);
  });

  it('updates routes for moves inside a manual free frame without a frame-fit command', () => {
    seed(
      [
        note('frame', 0, 0, {
          type: 'frame',
          data: { sizing: 'manual' },
          style: { width: 800, height: 800 },
        }),
        note('s', 100, 100, { parentId: 'frame' }),
        note('t', 500, 100, { parentId: 'frame' }),
      ],
      [edge('s', 't')],
    );
    drag('t', { x: 100, y: 500 });
    expect(node('t').parentId).toBe('frame');
    expect(state().edges[0]).toMatchObject(down);
  });

  it('re-evaluates routes when an unconnected obstacle moves away', () => {
    seed(
      [
        note('s', 0, 0),
        note('t', 300, 0),
        note('blocker', 110, 44, { style: { width: 40, height: 12 } }),
      ],
      [edge('s', 't')],
    );
    expect(state().edges[0]).not.toMatchObject(right);
    drag('blocker', { x: 1000, y: 1000 });
    expect(state().edges[0]).toMatchObject(right);
  });

  it('preserves small-movement hysteresis after re-evaluating a diagonal', () => {
    seed([note('s', 0, 0), note('t', 300, 300)], [edge('s', 't')]);
    const before = state().edges;
    drag('t', { x: 300, y: 301 });
    expect(state().edges).toBe(before);
  });

  it('re-evaluates a multi-node drag together and preserves internal relative routing', () => {
    seed(
      [note('a', 0, 0), note('b', 300, 0), note('fixed', 700, 0)],
      [edge('a', 'b'), edge('b', 'fixed')],
    );
    const internal = state().edges[0];
    start(['a', 'b']);
    for (const dragging of [true, false]) {
      move('a', { x: 400, y: -400 }, dragging);
      move('b', { x: 700, y: -400 }, dragging);
    }
    stop(['a', 'b']);
    expect(state().edges[0]).toBe(internal);
    expect(state().edges[1]).toMatchObject(down);
    state().undo();
    expect(node('a').position).toEqual({ x: 0, y: 0 });
    expect(node('b').position).toEqual({ x: 300, y: 0 });
    expect(state().edges[1]).toMatchObject(right);
    expect(canvasHistoryManager.canUndo).toBe(false);
  });

  it('undoes and redoes position and port changes together in one step', () => {
    seed([note('s', 0, 0), note('t', 300, 0)], [edge('s', 't')]);
    drag('t', { x: 0, y: 300 });
    expect(state().edges[0]).toMatchObject(down);
    state().undo();
    expect(node('t').position).toEqual({ x: 300, y: 0 });
    expect(state().edges[0]).toMatchObject(right);
    expect(canvasHistoryManager.canUndo).toBe(false);
    state().redo();
    expect(node('t').position).toEqual({ x: 0, y: 300 });
    expect(state().edges[0]).toMatchObject(down);
    expect(canvasHistoryManager.canRedo).toBe(false);
  });

  it('does not reroute or retain an undo step for a zero-distance drag', () => {
    seed([note('s', 0, 0), note('t', 300, 0)], [edge('s', 't')]);
    const before = state().edges;
    start(['t']);
    move('t', { x: 0, y: 300 }, true);
    move('t', { x: 300, y: 0 }, false);
    stop(['t']);
    expect(state().edges).toBe(before);
    expect(canvasHistoryManager.canUndo).toBe(false);
  });

  it('leaves routes unchanged when a drag is cancelled', () => {
    seed([note('s', 0, 0), note('t', 300, 0)], [edge('s', 't')]);
    const before = state().edges;
    start(['t']);
    move('t', { x: 0, y: 300 }, true);
    state().cancelActiveNodeDrag();
    expect(node('t').position).toEqual({ x: 300, y: 0 });
    expect(state().edges).toBe(before);
    expect(canvasHistoryManager.canUndo).toBe(false);
  });
});
