// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createNodeDragRecognizer } from './nodeDrag';

import type { CanvasPointerRouterContext } from '@/handler/canvasPointerRouterContext';
import type { Node } from '@xyflow/react';

const {
  cancelActiveNodeDrag,
  getState,
  nodeIdAtScreenPoint,
  onNodeDragStart,
  onNodeDragStop,
  onNodesChange,
} = vi.hoisted(() => ({
  cancelActiveNodeDrag: vi.fn(),
  getState: vi.fn(),
  nodeIdAtScreenPoint: vi.fn(),
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
  interactivityLocked: false,
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
  nodeIdAtScreenPoint.mockReturnValue(selectedNode.id);
  getState.mockImplementation(() => ({
    nodes: [selectedNode],
    cancelActiveNodeDrag,
    onNodeDragStart,
    onNodeDragStop,
    onNodesChange,
  }));
});

describe('createNodeDragRecognizer', () => {
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

  it('does not claim a selected node while canvas interactivity is locked', () => {
    const recognizer = createNodeDragRecognizer();

    expect(
      recognizer.canClaim(pointer(1, 0, 0), {
        ...context,
        interactivityLocked: true,
      }),
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

  it('cancels an active drag if interactivity becomes locked', () => {
    const recognizer = createNodeDragRecognizer();
    const down = pointer(3, 0, 0);

    expect(recognizer.onDown(down, context)).toBe('claim');
    recognizer.onMove?.(pointer(3, 9, 0), context);
    recognizer.onMove?.(pointer(3, 10, 0), {
      ...context,
      interactivityLocked: true,
    });

    expect(onNodeDragStart).toHaveBeenCalledTimes(1);
    expect(cancelActiveNodeDrag).toHaveBeenCalledTimes(1);
    expect(onNodeDragStop).not.toHaveBeenCalled();
  });

  it('does not carry selected Sketch nodes in a finger drag', () => {
    getState.mockImplementation(() => ({
      nodes: [selectedNode, selectedSketch],
      cancelActiveNodeDrag,
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
