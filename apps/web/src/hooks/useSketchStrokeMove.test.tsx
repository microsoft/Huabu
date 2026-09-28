// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import useCanvasStore from '@/store/canvasStore';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import { useSketchStrokeMove } from './useSketchStrokeMove';

import type { ReactFlowInstance } from '@xyflow/react';

const mocks = vi.hoisted(() => ({
  beginCanvasGesture: vi.fn(),
  endCanvasGesture: vi.fn(),
  updateCanvasGesture: vi.fn(),
}));

vi.mock('@/handler/canvasGestureSession', () => ({
  beginCanvasGesture: mocks.beginCanvasGesture,
  endCanvasGesture: mocks.endCanvasGesture,
  updateCanvasGesture: mocks.updateCanvasGesture,
}));

let root: Root;
let container: HTMLDivElement;
let handlers: ReturnType<typeof useSketchStrokeMove> | undefined;
const screenToFlowPosition = vi.fn(({ x, y }: { x: number; y: number }) => ({
  x,
  y,
}));
const rfInstanceRef = {
  current: { screenToFlowPosition } as unknown as ReactFlowInstance,
};

function Harness() {
  handlers = useSketchStrokeMove({ rfInstanceRef });
  return null;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.beginCanvasGesture.mockReturnValue(true);
  useGesturePreviewStore.getState().resetCanvasScopedTransients();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  useGesturePreviewStore.getState().resetCanvasScopedTransients();
  await act(async () => root.unmount());
  container.remove();
  handlers = undefined;
});

describe('useSketchStrokeMove', () => {
  it('does not claim a retained-region move while Ink submission is preparing', () => {
    useGesturePreviewStore.getState().setInkSubmissionPreparing(true);

    const claimed = handlers?.onPointerDown(
      new PointerEvent('pointerdown', {
        pointerId: 7,
        pointerType: 'touch',
        clientX: 40,
        clientY: 60,
      }),
    );

    expect(claimed).toBe(false);
    expect(mocks.beginCanvasGesture).not.toHaveBeenCalled();
    expect(screenToFlowPosition).not.toHaveBeenCalled();
  });

  it('cancels an already claimed move when submission preparation begins', () => {
    const polygon = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
    ];
    useGesturePreviewStore.getState().setSketchSelectionPolygon(polygon);
    expect(
      handlers?.onPointerDown(
        new PointerEvent('pointerdown', {
          pointerId: 8,
          pointerType: 'touch',
          clientX: 40,
          clientY: 60,
        }),
      ),
    ).toBe(true);
    useGesturePreviewStore
      .getState()
      .setSketchStrokeMovePreview({ dx: 10, dy: 12 });
    useGesturePreviewStore.getState().setInkSubmissionPreparing(true);

    handlers?.onPointerUp(
      new PointerEvent('pointerup', {
        pointerId: 8,
        pointerType: 'touch',
        clientX: 50,
        clientY: 72,
      }),
    );

    expect(mocks.endCanvasGesture).toHaveBeenCalledWith(8);
    expect(
      useGesturePreviewStore.getState().sketchStrokeMovePreview,
    ).toBeNull();
    expect(useGesturePreviewStore.getState().sketchSelectionPolygon).toEqual(
      polygon,
    );
  });

  it('cancels the node drag lifecycle when a mixed move was already locked', () => {
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [
        {
          id: 'note-1',
          type: 'note',
          selected: true,
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
    });
    const store = useCanvasStore.getState();
    const onNodeDragStart = vi
      .spyOn(store, 'onNodeDragStart')
      .mockImplementation(() => {});
    const onNodesChange = vi
      .spyOn(store, 'onNodesChange')
      .mockImplementation(() => {});
    const onNodeDrag = vi
      .spyOn(store, 'onNodeDrag')
      .mockImplementation(() => {});
    const cancelActiveNodeDrag = vi
      .spyOn(store, 'cancelActiveNodeDrag')
      .mockImplementation(() => {});
    mocks.updateCanvasGesture.mockReturnValue('locked');

    expect(
      handlers?.onPointerDown(
        new PointerEvent('pointerdown', {
          pointerId: 9,
          pointerType: 'touch',
          clientX: 40,
          clientY: 60,
        }),
      ),
    ).toBe(true);
    handlers?.onPointerMove(
      new PointerEvent('pointermove', {
        pointerId: 9,
        pointerType: 'touch',
        clientX: 50,
        clientY: 72,
      }),
    );
    expect(onNodeDragStart).toHaveBeenCalledOnce();

    useGesturePreviewStore.getState().setInkSubmissionPreparing(true);
    handlers?.onPointerUp(
      new PointerEvent('pointerup', {
        pointerId: 9,
        pointerType: 'touch',
        clientX: 50,
        clientY: 72,
      }),
    );

    expect(cancelActiveNodeDrag).toHaveBeenCalledOnce();
    expect(mocks.endCanvasGesture).toHaveBeenCalledWith(9);

    onNodeDragStart.mockRestore();
    onNodesChange.mockRestore();
    onNodeDrag.mockRestore();
    cancelActiveNodeDrag.mockRestore();
  });
});
