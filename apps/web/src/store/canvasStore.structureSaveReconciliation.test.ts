// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { putCanvas } = vi.hoisted(() => ({
  putCanvas: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof CanvasApi>()),
  putCanvas,
}));

import useCanvasStore from './canvasStore';
import { CanvasConflictError } from '../api/canvas';

import type * as CanvasApi from '../api';

function pendingEffects() {
  return {
    mutatedNodes: [],
    deletedNodeIds: [],
    contentEditedNodeIds: [],
    deferredFitFrameIds: [],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  putCanvas.mockReset();
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: 'canvas-race',
    nodes: [],
    edges: [],
    canvasTitle: 'Race',
    version: 10,
    isSaving: false,
    pendingSave: false,
    isLoading: true,
    versionConflict: false,
    versionConflictServerVersion: null,
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('canvasStore structure-save reconciliation', () => {
  it('does not let a delayed success lower an SSE-advanced version', async () => {
    let acknowledge:
      | ((value: { canvasId: string; version: number }) => void)
      | undefined;
    putCanvas.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );

    const save = useCanvasStore.getState().saveCanvas();
    useCanvasStore.getState().applyDeltasFromAgent([], 12, pendingEffects());
    acknowledge?.({ canvasId: 'canvas-race', version: 11 });
    await save;

    expect(useCanvasStore.getState().version).toBe(12);
    expect(useCanvasStore.getState().versionConflict).toBe(false);
  });

  it('retries a delayed 409 after SSE already reached its server version', async () => {
    let rejectSave: ((reason: unknown) => void) | undefined;
    putCanvas
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectSave = reject;
          }),
      )
      .mockResolvedValueOnce({ canvasId: 'canvas-race', version: 12 });

    const save = useCanvasStore.getState().saveCanvas();
    useCanvasStore.getState().applyDeltasFromAgent([], 11, pendingEffects());
    rejectSave?.(
      new CanvasConflictError({
        code: 'CANVAS_VERSION_CONFLICT',
        message: 'Canvas version mismatch',
        serverVersion: 11,
      }),
    );
    await save;
    await vi.waitFor(() => expect(putCanvas).toHaveBeenCalledTimes(2));

    expect(putCanvas.mock.calls.map((call) => call[1].version)).toEqual([
      10, 11,
    ]);
    expect(useCanvasStore.getState().version).toBe(12);
    expect(useCanvasStore.getState().versionConflict).toBe(false);
  });

  it('clears an earlier 409 and retries when SSE catches up later', async () => {
    putCanvas
      .mockRejectedValueOnce(
        new CanvasConflictError({
          code: 'CANVAS_VERSION_CONFLICT',
          message: 'Canvas version mismatch',
          serverVersion: 11,
        }),
      )
      .mockResolvedValueOnce({ canvasId: 'canvas-race', version: 12 });

    await useCanvasStore.getState().saveCanvas();
    expect(useCanvasStore.getState().versionConflict).toBe(true);
    expect(useCanvasStore.getState().versionConflictServerVersion).toBe(11);

    useCanvasStore.getState().applyDeltasFromAgent([], 11, pendingEffects());
    expect(useCanvasStore.getState().versionConflict).toBe(false);

    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(putCanvas).toHaveBeenCalledTimes(2));

    expect(putCanvas.mock.calls[1]?.[1].version).toBe(11);
    expect(useCanvasStore.getState().version).toBe(12);
  });
});
