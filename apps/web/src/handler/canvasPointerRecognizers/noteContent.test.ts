// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canTouchTakeOverCanvasGesture,
  getCanvasGesture,
  resetCanvasGestureForTests,
} from '@/handler/canvasGestureSession';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import { createNoteContentRecognizer } from './noteContent';

import type { CanvasPointerRouterContext } from '@/handler/canvasPointerRouterContext';
import type { Node } from '@xyflow/react';

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  nodeIdAtScreenPoint: vi.fn(),
  onNodeDragStart: vi.fn(),
  onNodesChange: vi.fn(),
  onNodeDragStop: vi.fn(),
  cancelActiveNodeDrag: vi.fn(),
  selectNodes: vi.fn(),
}));
vi.mock('@/store/canvasStore', () => ({
  default: { getState: mocks.getState },
}));
vi.mock('@/handler/canvasNodeAtPoint', () => ({
  nodeIdAtScreenPoint: mocks.nodeIdAtScreenPoint,
}));

let viewport: HTMLDivElement;
let wrapper: HTMLDivElement;
let nodes: Node[];
let ctx: CanvasPointerRouterContext;

function pointer(type: string, x = 50, y = 100, pointerType = 'touch') {
  const event = new PointerEvent(type, {
    pointerId: 1,
    pointerType,
    clientX: x,
    clientY: y,
    isPrimary: true,
    button: 0,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, 'target', { value: viewport });
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCanvasGestureForTests();
  useGesturePreviewStore.getState().resetCanvasScopedTransients();
  nodes = [
    {
      id: 'note',
      type: 'note',
      selected: true,
      position: { x: 0, y: 0 },
      data: {},
    },
  ];
  mocks.getState.mockImplementation(() => ({ nodes, ...mocks }));
  mocks.nodeIdAtScreenPoint.mockReturnValue('note');
  wrapper = document.createElement('div');
  wrapper.setPointerCapture = vi.fn();
  wrapper.hasPointerCapture = vi.fn(() => true);
  wrapper.releasePointerCapture = vi.fn();
  const node = document.createElement('div');
  node.className = 'react-flow__node';
  node.dataset.id = 'note';
  viewport = document.createElement('div');
  viewport.dataset.noteContentViewport = '';
  viewport.dataset.noteScrollEnabled = 'true';
  Object.defineProperties(viewport, {
    scrollHeight: { value: 600, configurable: true },
    clientHeight: { value: 200 },
    offsetHeight: { value: 200 },
  });
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 200, 100),
  );
  node.append(viewport);
  wrapper.append(node);
  document.body.append(wrapper);
  ctx = {
    wrapper,
    instance: {
      screenToFlowPosition: (point: { x: number; y: number }) => point,
    } as CanvasPointerRouterContext['instance'],
    inputMode: 'pen',
    explicitToolActive: false,
    onTouchTakeover: vi.fn(),
    onEmptyCanvasTap: vi.fn(),
    onNodeTap: vi.fn(),
  };
});

afterEach(() => {
  wrapper.remove();
  resetCanvasGestureForTests();
});

describe('Note content pointer ownership', () => {
  it.each(['touch', 'pen'])(
    'enters reading with a selected %s tap and deselects on the next tap',
    (type) => {
      const recognizer = createNoteContentRecognizer();
      const down = pointer('pointerdown', 50, 100, type);
      expect(recognizer.canClaim(down, ctx)).toBe(true);
      expect(recognizer.onDown(down, ctx)).toBe('claim');
      recognizer.onUp?.(pointer('pointerup', 50, 100, type), ctx);
      expect(useGesturePreviewStore.getState().noteReadingNodeId).toBe('note');
      expect(mocks.onNodeDragStart).not.toHaveBeenCalled();
      recognizer.onDown(down, ctx);
      recognizer.onUp?.(pointer('pointerup', 50, 100, type), ctx);
      expect(useGesturePreviewStore.getState().noteReadingNodeId).toBeNull();
      expect(mocks.selectNodes).toHaveBeenCalledWith([]);
    },
  );

  it('reuses ordinary dragging before reading without treating the release as a tap', () => {
    const recognizer = createNoteContentRecognizer();
    recognizer.onDown(pointer('pointerdown'), ctx);
    recognizer.onMove?.(pointer('pointermove', 80), ctx);
    recognizer.onUp?.(pointer('pointerup', 80), ctx);
    expect(mocks.onNodeDragStart).toHaveBeenCalledTimes(1);
    expect(mocks.onNodeDragStop).toHaveBeenCalledTimes(1);
    expect(useGesturePreviewStore.getState().noteReadingNodeId).toBeNull();
  });

  it('does not move a locked Note or turn its drag into a tap', () => {
    nodes[0].data.locked = true;
    const recognizer = createNoteContentRecognizer();
    recognizer.onDown(pointer('pointerdown'), ctx);
    recognizer.onMove?.(pointer('pointermove', 80), ctx);
    recognizer.onMove?.(pointer('pointermove', 100), ctx);
    recognizer.onUp?.(pointer('pointerup'), ctx);
    expect(mocks.onNodeDragStart).not.toHaveBeenCalled();
    expect(mocks.onNodeDragStop).not.toHaveBeenCalled();
    expect(mocks.onNodesChange).not.toHaveBeenCalled();
    expect(useGesturePreviewStore.getState().noteReadingNodeId).toBeNull();
  });

  it('scrolls in document coordinates and remains reading after a drag returns to its origin', () => {
    useGesturePreviewStore.setState({ noteReadingNodeId: 'note' });
    const recognizer = createNoteContentRecognizer();
    recognizer.onDown(pointer('pointerdown'), ctx);
    expect(canTouchTakeOverCanvasGesture()).toBe(true);
    recognizer.onMove?.(pointer('pointermove', 50, 60), ctx);
    expect(viewport.scrollTop).toBe(80);
    expect(canTouchTakeOverCanvasGesture()).toBe(false);
    recognizer.onMove?.(pointer('pointermove'), ctx);
    recognizer.onUp?.(pointer('pointerup'), ctx);
    expect(useGesturePreviewStore.getState().noteReadingNodeId).toBe('note');
    expect(mocks.selectNodes).not.toHaveBeenCalled();
    expect(mocks.onNodesChange).not.toHaveBeenCalled();
    expect(getCanvasGesture()).toBeNull();
  });

  it.each([false, true])(
    'cancellation never cycles state (reading=%s)',
    (reading) => {
      useGesturePreviewStore.setState({
        noteReadingNodeId: reading ? 'note' : null,
      });
      const recognizer = createNoteContentRecognizer();
      recognizer.onDown(pointer('pointerdown'), ctx);
      recognizer.onCancel?.(pointer('pointercancel'), ctx);
      recognizer.onUp?.(pointer('pointerup'), ctx);
      expect(useGesturePreviewStore.getState().noteReadingNodeId).toBe(
        reading ? 'note' : null,
      );
      expect(mocks.selectNodes).not.toHaveBeenCalled();
      expect(getCanvasGesture()).toBeNull();
      expect(wrapper.releasePointerCapture).toHaveBeenCalledWith(1);
    },
  );

  it('does not commit a pending tap after selection changes', () => {
    const recognizer = createNoteContentRecognizer();
    recognizer.onDown(pointer('pointerdown'), ctx);
    nodes[0].selected = false;
    recognizer.onUp?.(pointer('pointerup'), ctx);
    expect(useGesturePreviewStore.getState().noteReadingNodeId).toBeNull();
  });

  it.each([
    'mouse',
    'explicit-tool',
    'unselected',
    'multi-selected',
    'auto-height',
    'no-overflow',
    'mouse-mode',
  ])('yields for %s', (scenario) => {
    let pointerType = 'touch';
    if (scenario === 'mouse') pointerType = 'mouse';
    if (scenario === 'explicit-tool') ctx.explicitToolActive = true;
    if (scenario === 'unselected') nodes[0].selected = false;
    if (scenario === 'multi-selected')
      nodes.push({ ...nodes[0], id: 'second' });
    if (scenario === 'auto-height')
      viewport.dataset.noteScrollEnabled = 'false';
    if (scenario === 'no-overflow')
      Object.defineProperty(viewport, 'scrollHeight', { value: 200 });
    if (scenario === 'mouse-mode') ctx.inputMode = 'mouse';
    expect(
      createNoteContentRecognizer().canClaim(
        pointer('pointerdown', 50, 100, pointerType),
        ctx,
      ),
    ).toBe(false);
  });
});
