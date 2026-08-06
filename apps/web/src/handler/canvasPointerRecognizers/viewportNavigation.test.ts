// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  nodeIdAtScreenPoint: vi.fn(() => 'node-1'),
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

function pointer(pointerId: number): PointerEvent {
  return {
    pointerId,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    clientX: 10,
    clientY: 20,
    target: document.createElement('div'),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as PointerEvent;
}

function context(interactivityLocked: boolean): CanvasPointerRouterContext {
  return {
    inputMode: 'pen',
    interactivityLocked,
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
});

describe('createViewportNavigationRecognizer', () => {
  it('does not mutate selection on a touch tap while interactivity is locked', () => {
    const recognizer = createViewportNavigationRecognizer();
    const ctx = context(true);
    const event = pointer(1);

    expect(recognizer.onDown(event, ctx)).toBe('claim');
    recognizer.onUp?.(event, ctx);

    expect(ctx.onNodeTap).not.toHaveBeenCalled();
    expect(ctx.onEmptyCanvasTap).not.toHaveBeenCalled();
  });

  it('retains touch tap selection while interactivity is unlocked', () => {
    const recognizer = createViewportNavigationRecognizer();
    const ctx = context(false);
    const event = pointer(2);

    expect(recognizer.onDown(event, ctx)).toBe('claim');
    recognizer.onUp?.(event, ctx);

    expect(ctx.onNodeTap).toHaveBeenCalledWith('node-1');
    expect(ctx.onEmptyCanvasTap).not.toHaveBeenCalled();
  });
});
