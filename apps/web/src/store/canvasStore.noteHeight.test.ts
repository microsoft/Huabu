// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { autoHeightKey } from '@huabu/shared/canvas-engine';

import { measureNoteHeightOffscreen } from '@/components/Nodes/shared/height/measure/offscreenMeasurer';

import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore from './canvasStore';

import type { Node } from '@xyflow/react';

vi.mock('@/components/Nodes/shared/height/measure/offscreenMeasurer', () => ({
  measureNoteHeightOffscreen: vi.fn(),
}));
const measure = vi.mocked(measureNoteHeightOffscreen);
const note = (width = 400): Node => ({
  id: 'n1',
  type: 'note',
  position: { x: 0, y: 0 },
  style: { width, height: 300 },
  data: { type: 'note', content: '# hello', heightMode: 'fixed' },
});

beforeEach(() => {
  vi.useFakeTimers();
  measure.mockReset();
  canvasHistoryManager.activate('height-test', true);
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: 'height-test',
    nodes: [note()],
    edges: [],
    isLoading: false,
    isSaving: false,
    pendingSave: false,
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('store Note height toggle', () => {
  it('commits actual-width measurement with the auto toggle', async () => {
    measure.mockResolvedValue({ height: 120, provisional: false });
    useCanvasStore.getState().setNoteHeightMode(['n1'], 'auto');
    await vi.advanceTimersByTimeAsync(0);
    const node = useCanvasStore.getState().nodes[0];
    expect(node.style).toMatchObject({ width: 400, height: 128 });
    expect(node.data.heightMode).toBe('auto');
    expect(node.data.autoHeight).toEqual({
      intrinsicHeight: 120,
      measuredFor: autoHeightKey(node),
    });
  });

  it('does not replay the old width when a fixed Note resizes during measurement', async () => {
    measure.mockImplementation(async () => {
      useCanvasStore.getState()._setStateNoAutosave({ nodes: [note(800)] });
      return { height: 120, provisional: false };
    });
    useCanvasStore.getState().setNoteHeightMode(['n1'], 'auto');
    await vi.advanceTimersByTimeAsync(0);
    const node = useCanvasStore.getState().nodes[0];
    expect(node.style).toMatchObject({ width: 800, height: 300 });
    expect(node.data.heightMode).toBe('fixed');
    expect(node.data.autoHeight).toBeUndefined();
  });

  it('does not apply a pending toggle in another canvas', async () => {
    measure.mockImplementation(async () => {
      useCanvasStore
        .getState()
        ._setStateNoAutosave({ canvasId: 'other-canvas', nodes: [note()] });
      return { height: 120, provisional: false };
    });
    useCanvasStore.getState().setNoteHeightMode(['n1'], 'auto');
    await vi.advanceTimersByTimeAsync(0);
    expect(useCanvasStore.getState().nodes[0].data.heightMode).toBe('fixed');
  });
});
