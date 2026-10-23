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
