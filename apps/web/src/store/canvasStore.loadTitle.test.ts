// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getCanvas: vi.fn() }));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof canvasApi>()),
  ...api,
}));

import useCanvasStore from './canvasStore';

import type * as canvasApi from '../api';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: 'previous',
    canvasTitle: 'Previous Space',
    nodes: [],
    edges: [],
    isLoading: false,
    isSaving: false,
    pendingSave: false,
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('canvas title ownership during loading', () => {
  it('clears the outgoing title before fetching and installs the loaded title', async () => {
    let resolve!: (
      value: Awaited<ReturnType<typeof canvasApi.getCanvas>>,
    ) => void;
    api.getCanvas.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );

    const loading = useCanvasStore.getState().loadCanvas('next');
    expect(useCanvasStore.getState()).toMatchObject({
      canvasId: 'next',
      canvasTitle: '',
      isLoading: true,
      pendingSave: false,
    });

    resolve({
      canvasId: 'next',
      title: 'Next Space',
      version: 1,
      state: { nodes: [], edges: [] },
    });
    await loading;
    expect(useCanvasStore.getState()).toMatchObject({
      canvasTitle: 'Next Space',
      isLoading: false,
      pendingSave: false,
    });
  });

  it('does not restore the outgoing title after a failed request', async () => {
    const error = new Error('Load failed');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.getCanvas.mockRejectedValue(error);
    await useCanvasStore.getState().loadCanvas('next');
    expect(useCanvasStore.getState()).toMatchObject({
      canvasId: 'next',
      canvasTitle: '',
      isLoading: false,
    });
    expect(log).toHaveBeenCalledWith('Failed to load canvas:', error);
  });

  it('retains the current title when reloading the same Space fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.getCanvas.mockRejectedValue(new Error('Reload failed'));
    await useCanvasStore.getState().loadCanvas('previous');
    expect(useCanvasStore.getState().canvasTitle).toBe('Previous Space');
  });
});
