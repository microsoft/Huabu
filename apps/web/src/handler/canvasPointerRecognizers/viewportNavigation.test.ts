// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import useCanvasStore from '@/store/canvasStore';

import { createViewportNavigationRecognizer } from './viewportNavigation';

import type { CanvasPointerRouterContext } from '@/handler/canvasPointerRouterContext';

const {
  beginCanvasGesture,
  endCanvasGesture,
  nodeIdAtScreenPoint,
  updateCanvasGesture,
} = vi.hoisted(() => ({
  beginCanvasGesture: vi.fn(() => true),
  endCanvasGesture: vi.fn(),
  nodeIdAtScreenPoint: vi.fn<
    (
      clientX: number,
      clientY: number,
      options?: { excludeNodeIds?: ReadonlySet<string> },
    ) => string | null
  >(() => 'node-1'),
  updateCanvasGesture: vi.fn(() => 'pending'),
}));

vi.mock('@/handler/canvasGestureSession', () => ({
  beginCanvasGesture,
  cancelPendingCanvasGesture: vi.fn(),
  endCanvasGesture,
  updateCanvasGesture,
}));
vi.mock('@/handler/canvasInteractionOwner', () => ({
  canTouchClaimViewport: vi.fn(() => true),
  canTouchTakeOverForPinch: vi.fn(() => true),
}));
vi.mock('@/handler/canvasNodeAtPoint', () => ({ nodeIdAtScreenPoint }));

function pointer(pointerId: number, target?: Element): PointerEvent {
  return {
    pointerId,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    clientX: 10,
    clientY: 20,
    target: target ?? document.createElement('div'),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as PointerEvent;
}

function context(): CanvasPointerRouterContext {
  return {
    inputMode: 'pen',
    explicitToolActive: false,
    onTouchTakeover: vi.fn(),
    onEmptyCanvasTap: vi.fn(),
    onNodeTap: vi.fn(),
    wrapper: document.createElement('div'),
    instance: {
      getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
    },
  } as unknown as CanvasPointerRouterContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  beginCanvasGesture.mockReturnValue(true);
  updateCanvasGesture.mockReturnValue('pending');
  nodeIdAtScreenPoint.mockReturnValue('node-1');
  useCanvasStore.getState()._setStateNoAutosave({
    nodes: [
      {
        id: 'sketch-1',
        type: 'sketch',
        position: { x: 0, y: 0 },
        data: {},
      },
    ],
  });
});

describe('createViewportNavigationRecognizer', () => {
  it.each(['react-flow__handle', 'react-flow__resize-control'])(
    'does not observe or claim a Sketch %s touch',
    (controlClass) => {
      const recognizer = createViewportNavigationRecognizer();
      const ctx = context();
      const sketch = document.createElement('div');
      sketch.className = 'react-flow__node react-flow__node-sketch';
      const control = document.createElement('div');
      control.className = controlClass;
      sketch.append(control);
      const event = pointer(3, control);
      const observerContext = {
        ...ctx,
        preempt: vi.fn(),
        cancelPointer: vi.fn(),
      };

      recognizer.observe?.onDown?.(event, observerContext);

      expect(recognizer.canClaim(event, ctx)).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
    },
  );

  it('selects an ordinary node on a touch tap', () => {
    const recognizer = createViewportNavigationRecognizer();
    const ctx = context();
    const event = pointer(2);

    expect(recognizer.onDown(event, ctx)).toBe('claim');
    recognizer.onUp?.(event, ctx);

    expect(ctx.onNodeTap).toHaveBeenCalledWith('node-1');
    expect(ctx.onEmptyCanvasTap).not.toHaveBeenCalled();
    expect(nodeIdAtScreenPoint).toHaveBeenCalledWith(
      10,
      20,
      expect.objectContaining({
        excludeNodeIds: expect.objectContaining({ has: expect.any(Function) }),
      }),
    );
    const options = nodeIdAtScreenPoint.mock.calls[0]?.[2];
    expect(options?.excludeNodeIds?.has('sketch-1')).toBe(true);
  });
});
