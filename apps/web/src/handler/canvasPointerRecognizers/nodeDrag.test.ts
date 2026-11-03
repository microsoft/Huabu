// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useInkSigilStore } from '@/store/inkSigilStore';

import { createNodeDragRecognizer } from './nodeDrag';

import type { CanvasPointerRouterContext } from '@/handler/canvasPointerRouterContext';
import type { Node } from '@xyflow/react';

const {
  cancelActiveNodeDrag,
  getState,
  nodeIdAtScreenPoint,
  onNodeDrag,
  onNodeDragStart,
  onNodeDragStop,
  onNodesChange,
} = vi.hoisted(() => ({
  cancelActiveNodeDrag: vi.fn(),
  getState: vi.fn(),
  nodeIdAtScreenPoint: vi.fn(),
  onNodeDrag: vi.fn(),
  onNodeDragStart: vi.fn(),
  onNodeDragStop: vi.fn(),
  onNodesChange: vi.fn(),
}));

vi.mock('@/handler/canvasNodeAtPoint', () => ({ nodeIdAtScreenPoint }));
vi.mock('@/store/canvasStore', () => ({
  default: { getState },
}));

const selectedNode = {
  id: 'selected',
  selected: true,
  position: { x: 10, y: 20 },
  data: {},
} as Node;

const selectedSketch = {
  id: 'sketch-1',
  type: 'sketch',
  selected: true,
  position: { x: 30, y: 40 },
  data: {},
} as Node;

const context = {
  inputMode: 'pen',
  instance: {
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
  },
} as CanvasPointerRouterContext;

function pointer(
  pointerId: number,
  clientX: number,
  clientY: number,
  target?: Element,
): PointerEvent {
  return {
    pointerId,
    pointerType: 'touch',
    isPrimary: true,
    clientX,
    clientY,
    target: target ?? document.createElement('div'),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as PointerEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  useInkSigilStore.setState({ pending: null });
  nodeIdAtScreenPoint.mockReturnValue(selectedNode.id);
  getState.mockImplementation(() => ({
    nodes: [selectedNode],
    cancelActiveNodeDrag,
    onNodeDrag,
    onNodeDragStart,
    onNodeDragStop,
    onNodesChange,
  }));
});

describe('createNodeDragRecognizer', () => {
  it.each(['locked', 'inherited', 'movable'] as const)(
    'reports movement permission separately from the drag threshold for a %s press',
    (restriction) => {
      const frame: Node = {
        id: 'frame',
        type: 'frame',
        position: { x: 100, y: 200 },
        data: {},
      };
      getState.mockReturnValue({
        ...getState(),
        nodes: [
          frame,
          { ...selectedNode, id: 'first', parentId: frame.id },
          { ...selectedNode, id: 'second', parentId: frame.id },
          {
            ...selectedNode,
            data: { locked: restriction === 'locked' },
            draggable: restriction !== 'inherited',
          },
        ],
      });
      const onActiveChange = vi.fn();
      const onTap = vi.fn();
      const recognizer = createNodeDragRecognizer({
        acceptsPointer: () => true,
        onActiveChange,
        onTap,
      });
      recognizer.onDown(pointer(1, 0, 0), context);
      recognizer.onUp?.(pointer(1, 0, 0), context);
      expect(onTap).toHaveBeenCalledOnce();
      onTap.mockClear();
      recognizer.onDown(pointer(2, 0, 0), context);
      recognizer.onMove?.(pointer(2, 20, 0), context);
      recognizer.onUp?.(pointer(2, 0, 0), context);
      expect(onActiveChange.mock.calls).toEqual([
        [true, restriction === 'movable'],
        [false, restriction === 'movable'],
      ]);
      expect(onTap).not.toHaveBeenCalled();
      expect(onNodeDragStart).toHaveBeenCalledTimes(
        restriction === 'movable' ? 1 : 0,
      );
      expect(onNodeDragStop).toHaveBeenCalledTimes(
        restriction === 'movable' ? 1 : 0,
      );
    },
  );

  it.each(['mouse', 'pen'])(
    'uses the actual %s target beneath transparent Sketch bounds to move a covered Frame',
    (pointerType) => {
      const frame: Node = {
        id: 'frame',
        type: 'frame',
        position: { x: 100, y: 200 },
        data: {},
      };
      const store = getState();
      getState.mockReturnValue({
        ...store,
        nodes: [
          frame,
          { ...selectedNode, parentId: frame.id },
          { ...selectedNode, id: 'other', parentId: frame.id },
          { ...selectedSketch, selected: false },
        ],
      });
      nodeIdAtScreenPoint.mockReturnValue(selectedSketch.id);
      const target = document.createElement('div');
      target.className = 'react-flow__node';
      target.dataset.id = selectedNode.id;
      const body = document.createElement('span');
      target.append(body);
      const event = { ...pointer(1, 100, 100, body), pointerType };
      const recognizer = createNodeDragRecognizer({
        acceptsPointer: () => true,
      });
      expect(recognizer.canClaim(event, context)).toBe(true);
      recognizer.onDown(event, context);
      recognizer.onMove?.({ ...event, clientX: 120 }, context);
      expect(onNodeDragStart).toHaveBeenCalledWith(expect.anything(), frame, [
        frame,
      ]);
      expect(nodeIdAtScreenPoint).not.toHaveBeenCalled();
    },
  );

  it.each(['mouse', 'pen'])(
    'still directly drags a selected Sketch with %s',
    (pointerType) => {
      getState.mockReturnValue({ ...getState(), nodes: [selectedSketch] });
      const target = document.createElement('div');
      target.className = 'react-flow__node';
      target.dataset.id = selectedSketch.id;
      const event = { ...pointer(1, 100, 100, target), pointerType };
      const recognizer = createNodeDragRecognizer({
        acceptsPointer: () => true,
      });
      expect(recognizer.canClaim(event, context)).toBe(true);
      recognizer.onDown(event, context);
      recognizer.onMove?.({ ...event, clientX: 120 }, context);
      expect(onNodeDragStart).toHaveBeenCalledWith(
        expect.anything(),
        selectedSketch,
        [selectedSketch],
      );
      expect(nodeIdAtScreenPoint).not.toHaveBeenCalled();
    },
  );

  it('moves a fully covered Frame while taps still target the pressed child', () => {
    const frame: Node = {
      id: 'frame',
      type: 'frame',
      position: { x: 100, y: 200 },
      data: {},
    };
    const nodes = [
      frame,
      { ...selectedNode, parentId: frame.id },
      { ...selectedNode, id: 'other', parentId: frame.id },
    ];
    getState.mockImplementation(() => ({
      nodes,
      cancelActiveNodeDrag,
      onNodeDrag,
      onNodeDragStart,
      onNodeDragStop,
      onNodesChange,
    }));
    const onTap = vi.fn();
    const recognizer = createNodeDragRecognizer({
      acceptsPointer: () => true,
      onTap,
    });
    recognizer.onDown(pointer(1, 100, 100), context);
    recognizer.onUp?.(pointer(1, 100, 100), context);
    expect(onTap).toHaveBeenCalledWith(selectedNode.id, expect.anything());
    recognizer.onDown(pointer(2, 100, 100), context);
    recognizer.onMove?.(pointer(2, 120, 130), context);
    expect(onNodeDragStart).toHaveBeenCalledWith(expect.anything(), frame, [
      frame,
    ]);
    expect(onNodesChange).toHaveBeenLastCalledWith([
      {
        type: 'position',
        id: 'frame',
        position: { x: 120, y: 230 },
        dragging: true,
      },
    ]);
    recognizer.onUp?.(pointer(2, 140, 150), context);
    expect(onNodesChange).toHaveBeenLastCalledWith([
      {
        type: 'position',
        id: 'frame',
        position: { x: 140, y: 250 },
        dragging: false,
      },
    ]);
    expect(nodes.filter((n) => n.selected).map((n) => n.id)).toEqual([
      'selected',
      'other',
    ]);
  });

  it('publishes live preview geometry and pointer coordinates after activation', () => {
    const recognizer = createNodeDragRecognizer();
    recognizer.onDown(pointer(1, 100, 100), context);
    recognizer.onMove?.(pointer(1, 105, 100), context);
    expect(onNodeDrag).not.toHaveBeenCalled();
    recognizer.onMove?.(pointer(1, 120, 130), context);
    expect(onNodeDrag).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientX: 120, clientY: 130 }),
      expect.objectContaining({ id: 'selected', position: { x: 30, y: 50 } }),
      [expect.objectContaining({ id: 'selected', position: { x: 30, y: 50 } })],
    );
    recognizer.onMove?.(pointer(1, 140, 150), context);
    expect(onNodeDrag).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientX: 140, clientY: 150 }),
      expect.objectContaining({ id: 'selected', position: { x: 50, y: 70 } }),
      [expect.objectContaining({ id: 'selected', position: { x: 50, y: 70 } })],
    );
    expect(onNodesChange.mock.invocationCallOrder[0]).toBeLessThan(
      onNodeDrag.mock.invocationCallOrder[0],
    );
  });

  it('keeps the original flow anchor across viewport pans and forwards modifiers', () => {
    let pan = 0;
    const ctx = {
      ...context,
      instance: {
        ...context.instance,
        screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({
          x: x - pan,
          y,
        }),
      },
    } as CanvasPointerRouterContext;
    const recognizer = createNodeDragRecognizer();
    recognizer.onDown(pointer(1, 100, 100), ctx);
    const event = { ...pointer(1, 120, 130), altKey: true, ctrlKey: true };
    recognizer.onMove?.(event, ctx);
    pan = -40;
    recognizer.onMove?.(event, ctx);
    expect(onNodesChange).toHaveBeenLastCalledWith([
      {
        type: 'position',
        id: selectedNode.id,
        position: { x: 70, y: 50 },
        dragging: true,
      },
    ]);
    expect(onNodeDragStart.mock.calls[0][0]).toBe(event);
    expect(onNodeDrag.mock.lastCall?.[0]).toBe(event);
    recognizer.onUp?.(event, ctx);
    expect(onNodeDragStop.mock.lastCall?.[0]).toBe(event);
  });

  it.each(['mouse', 'pen', 'touch'])(
    'uses the full nested selection before pruning for %s',
    (pointerType) => {
      const outer: Node = {
        id: 'outer',
        type: 'frame',
        position: { x: 100, y: 200 },
        data: {},
      };
      const inner: Node = {
        ...selectedNode,
        id: 'inner',
        type: 'frame',
        parentId: outer.id,
      };
      const child: Node = { ...selectedNode, parentId: inner.id };
      const store = getState();
      getState.mockReturnValue({ ...store, nodes: [outer, inner, child] });
      const recognizer = createNodeDragRecognizer({
        acceptsPointer: () => true,
        onTap: vi.fn(),
      });
      recognizer.onDown({ ...pointer(1, 100, 100), pointerType }, context);
      recognizer.onMove?.({ ...pointer(1, 120, 130), pointerType }, context);
      expect(onNodeDragStart).toHaveBeenCalledWith(expect.anything(), outer, [
        outer,
      ]);
      expect(onNodesChange).toHaveBeenLastCalledWith([
        {
          type: 'position',
          id: outer.id,
          position: { x: 120, y: 230 },
          dragging: true,
        },
      ]);
      expect(inner.selected).toBe(true);
      expect(child.selected).toBe(true);
      expect(outer.selected).toBeUndefined();
    },
  );

  it('does not restore old geometry or undo state after changing canvas', () => {
    const recognizer = createNodeDragRecognizer();
    recognizer.onDown(pointer(1, 0, 0), context);
    recognizer.onMove?.(pointer(1, 20, 0), context);
    getState.mockReturnValue({ canvasId: 'new-space' });
    recognizer.onCancel?.(pointer(1, 20, 0), context);
    expect(cancelActiveNodeDrag).not.toHaveBeenCalled();
    expect(onNodeDragStop).not.toHaveBeenCalled();
  });

  it('yields selected-node finger taps to a pending resource binding', () => {
    useInkSigilStore.setState({
      pending: {
        canvasId: 'space',
        strokeIds: ['s1', 's2', 's3', 's4'],
        fingerprint: '1234567890abcdef',
      },
    });
    expect(createNodeDragRecognizer().canClaim(pointer(1, 0, 0), context)).toBe(
      false,
    );
    expect(nodeIdAtScreenPoint).not.toHaveBeenCalled();
  });
  it('does not claim an out-of-body toolbar grip owned by its portal hook', () => {
    nodeIdAtScreenPoint.mockReturnValue(null);
    const node = document.createElement('div');
    node.className = 'react-flow__node';
    node.dataset.id = selectedNode.id;
    const grip = document.createElement('div');
    grip.setAttribute('data-node-drag-handle', '');
    const icon = document.createElement('span');
    grip.append(icon);
    node.append(grip);
    const event = {
      ...pointer(1, 900, 900),
      target: icon,
    } as unknown as PointerEvent;
    const recognizer = createNodeDragRecognizer();
    expect(recognizer.canClaim(event, context)).toBe(false);
    expect(onNodeDragStart).not.toHaveBeenCalled();
  });

  it('does not let an unselected grip claim a Pen-mode finger drag', () => {
    nodeIdAtScreenPoint.mockReturnValue(null);
    const node = document.createElement('div');
    node.className = 'react-flow__node';
    node.dataset.id = 'unselected';
    const grip = document.createElement('div');
    grip.setAttribute('data-node-drag-handle', '');
    node.append(grip);
    expect(
      createNodeDragRecognizer().canClaim(
        { ...pointer(1, 0, 0), target: grip } as unknown as PointerEvent,
        context,
      ),
    ).toBe(false);
  });

  it.each(['react-flow__handle', 'react-flow__resize-control'])(
    'does not claim a touch on a Sketch %s over a selected node',
    (controlClass) => {
      const recognizer = createNodeDragRecognizer();
      const sketch = document.createElement('div');
      sketch.className = 'react-flow__node react-flow__node-sketch';
      const control = document.createElement('div');
      control.className = controlClass;
      sketch.append(control);

      expect(recognizer.canClaim(pointer(5, 0, 0, control), context)).toBe(
        false,
      );
      expect(nodeIdAtScreenPoint).not.toHaveBeenCalled();
    },
  );

  it('cancels a locked drag without running drop resolution', () => {
    const recognizer = createNodeDragRecognizer();
    const down = pointer(1, 0, 0);

    expect(recognizer.canClaim(down, context)).toBe(true);
    expect(recognizer.onDown(down, context)).toBe('claim');
    recognizer.onMove?.(pointer(1, 9, 0), context);
    recognizer.onCancel?.(pointer(1, 9, 0), context);

    expect(onNodeDragStart).toHaveBeenCalledTimes(1);
    expect(cancelActiveNodeDrag).toHaveBeenCalledTimes(1);
    expect(onNodeDragStop).not.toHaveBeenCalled();
  });

  it('does not cancel store drag state before activation', () => {
    const recognizer = createNodeDragRecognizer();
    const down = pointer(2, 0, 0);

    expect(recognizer.onDown(down, context)).toBe('claim');
    recognizer.onMove?.(pointer(2, 7, 0), context);
    recognizer.onCancel?.(pointer(2, 7, 0), context);

    expect(onNodeDragStart).not.toHaveBeenCalled();
    expect(cancelActiveNodeDrag).not.toHaveBeenCalled();
    expect(onNodeDragStop).not.toHaveBeenCalled();
  });

  it('does not carry selected Sketch nodes in a finger drag', () => {
    getState.mockImplementation(() => ({
      nodes: [selectedNode, selectedSketch],
      cancelActiveNodeDrag,
      onNodeDrag,
      onNodeDragStart,
      onNodeDragStop,
      onNodesChange,
    }));
    const recognizer = createNodeDragRecognizer();
    const down = pointer(4, 0, 0);

    expect(recognizer.onDown(down, context)).toBe('claim');
    recognizer.onMove?.(pointer(4, 9, 0), context);

    expect(onNodeDragStart).toHaveBeenCalledWith(
      expect.anything(),
      selectedNode,
      [selectedNode],
    );
    const options = nodeIdAtScreenPoint.mock.calls[0]?.[2];
    expect(options?.excludeNodeIds.has(selectedSketch.id)).toBe(true);
  });
});
