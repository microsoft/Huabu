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
): PointerEvent {
  return {
    pointerId,
    pointerType: 'touch',
    isPrimary: true,
    clientX,
    clientY,
    target: document.createElement('div'),
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
  it('does not claim a selected node while canvas interactivity is locked', () => {
    const recognizer = createNodeDragRecognizer();

    expect(
      recognizer.canClaim(pointer(1, 0, 0), {
        ...context,
        interactivityLocked: true,
      }),
    ).toBe(false);
  });

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
});
