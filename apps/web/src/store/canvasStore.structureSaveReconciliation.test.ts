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

import useCanvasStore, {
  CanvasSubmissionSaveError,
  drainPendingSaves,
  saveCanvasForSubmission,
} from './canvasStore';
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
  it('retries a retained transient failure once per drain and succeeds after recovery', async () => {
    useCanvasStore.getState()._setStateNoAutosave({ isLoading: false });
    putCanvas.mockRejectedValue(new Error('offline'));
    await useCanvasStore.getState().saveCanvas();
    await expect(drainPendingSaves()).rejects.toThrow('offline');
    expect(putCanvas).toHaveBeenCalledTimes(2);
    putCanvas.mockResolvedValue({ canvasId: 'canvas-race', version: 11 });
    await expect(drainPendingSaves()).resolves.toBeUndefined();
    expect(putCanvas).toHaveBeenCalledTimes(3);
    await drainPendingSaves();
    expect(putCanvas).toHaveBeenCalledTimes(3);
  });

  it('does not retry retained failures against nodes from an incomplete return load', async () => {
    putCanvas.mockRejectedValue(new Error('offline'));
    await useCanvasStore.getState().saveCanvas();
    await expect(drainPendingSaves()).rejects.toThrow('offline');
    expect(putCanvas).toHaveBeenCalledOnce();
  });

  it('does not automatically retry a retained conflict', async () => {
    useCanvasStore.getState()._setStateNoAutosave({ isLoading: false });
    putCanvas.mockRejectedValue(
      new CanvasConflictError({
        code: 'CANVAS_VERSION_CONFLICT',
        message: 'conflict',
        serverVersion: 12,
      }),
    );
    await useCanvasStore.getState().saveCanvas();
    await expect(drainPendingSaves()).rejects.toThrow('conflict');
    expect(putCanvas).toHaveBeenCalledOnce();
  });

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

  it('blocks submission after a failed structure save until a save succeeds', async () => {
    putCanvas.mockRejectedValueOnce(new Error('disk unavailable'));

    await useCanvasStore.getState().saveCanvas();

    await expect(saveCanvasForSubmission('canvas-race')).rejects.toMatchObject({
      name: 'CanvasSubmissionSaveError',
      canvasId: 'canvas-race',
    } satisfies Partial<CanvasSubmissionSaveError>);

    putCanvas.mockResolvedValueOnce({ canvasId: 'canvas-race', version: 11 });
    await useCanvasStore.getState().saveCanvas();

    await expect(
      saveCanvasForSubmission('canvas-race'),
    ).resolves.toBeUndefined();
  });

  it('rejects only the conflicted Canvas, not an offscreen submission', async () => {
    useCanvasStore.getState()._setStateNoAutosave({ versionConflict: true });

    await expect(saveCanvasForSubmission('canvas-race')).rejects.toBeInstanceOf(
      CanvasSubmissionSaveError,
    );
    await expect(
      saveCanvasForSubmission('other-canvas'),
    ).resolves.toBeUndefined();
    expect(putCanvas).not.toHaveBeenCalled();
  });

  it('retains structure-save failures after navigating away', async () => {
    putCanvas.mockRejectedValueOnce(new Error('disk unavailable'));
    await useCanvasStore.getState().saveCanvas();
    useCanvasStore.getState()._setStateNoAutosave({
      canvasId: 'parent-canvas',
      versionConflict: false,
    });
    await expect(saveCanvasForSubmission('canvas-race')).rejects.toMatchObject({
      name: 'CanvasSubmissionSaveError',
      cause: { message: 'disk unavailable' },
    });
    expect(putCanvas).toHaveBeenCalledOnce();
  });

  it('finishes submission persistence when navigation follows an in-flight save', async () => {
    let acknowledge!: (value: { canvasId: string; version: number }) => void;
    putCanvas.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    const saving = useCanvasStore.getState().saveCanvas();
    const submission = saveCanvasForSubmission('canvas-race');
    acknowledge({ canvasId: 'canvas-race', version: 11 });
    await saving;
    useCanvasStore.getState()._setStateNoAutosave({
      canvasId: 'parent-canvas',
      versionConflict: true,
    });
    await expect(submission).resolves.toBeUndefined();
    expect(putCanvas).toHaveBeenCalledOnce();
  });
});
