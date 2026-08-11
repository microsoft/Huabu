// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import {
  createCanvasSnapshotCatchup,
  runCanvasSyncReconnectLoop,
} from './canvasSyncLifecycle';

describe('canvas sync snapshot catch-up', () => {
  it('reloads a newer snapshot retained behind a delayed initial GET', async () => {
    const state = {
      canvasId: 'canvas-1',
      version: 0,
      isLoading: true,
      structureDirtyGeneration: 0,
      structureSyncedGeneration: 0,
      pendingContentNodeIds: [] as string[],
    };
    const reload = vi.fn(async () => {
      state.isLoading = true;
      state.version = 2;
      state.isLoading = false;
    });
    const catchup = createCanvasSnapshotCatchup({
      getState: () => state,
      reload,
    });

    // Stream snapshot v2 arrives while the primary GET, which already read
    // v1 on the server, is still delayed in transit.
    await catchup.observe('canvas-1', 2);
    expect(reload).not.toHaveBeenCalled();

    // The delayed response installs v1. The loading transition subscriber in
    // canvasSyncStore calls reconcile and must now heal to retained v2.
    state.version = 1;
    state.isLoading = false;
    await catchup.reconcile();

    expect(reload).toHaveBeenCalledOnce();
    expect(state.version).toBe(2);
  });

  it('retains the highest snapshot while a load is active', async () => {
    const state = {
      canvasId: 'canvas-1',
      version: 1,
      isLoading: true,
      structureDirtyGeneration: 0,
      structureSyncedGeneration: 0,
      pendingContentNodeIds: [] as string[],
    };
    const reload = vi.fn(async () => undefined);
    const catchup = createCanvasSnapshotCatchup({
      getState: () => state,
      reload,
    });

    await catchup.observe('canvas-1', 2);
    await catchup.observe('canvas-1', 4);
    await catchup.observe('canvas-1', 3);
    state.version = 3;
    state.isLoading = false;
    await catchup.reconcile();

    expect(reload).toHaveBeenCalledWith('canvas-1');
  });

  it('retains the target after a failed/no-progress reload without spinning', async () => {
    const state = {
      canvasId: 'canvas-1',
      version: 1,
      isLoading: false,
      structureDirtyGeneration: 0,
      structureSyncedGeneration: 0,
      pendingContentNodeIds: [] as string[],
    };
    const reload = vi.fn(async () => undefined);
    const catchup = createCanvasSnapshotCatchup({
      getState: () => state,
      reload,
    });

    await catchup.observe('canvas-1', 2);
    expect(reload).toHaveBeenCalledOnce();

    // A later external signal retries the retained target. The failed reload
    // itself must not recursively hammer the endpoint.
    await catchup.reconcile();
    expect(reload).toHaveBeenCalledTimes(2);
    state.version = 2;
    await catchup.reconcile();
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

describe('canvas sync reconnect lifecycle', () => {
  it('reconnects after EOF and forwards the next stream snapshot and update', async () => {
    const controller = new AbortController();
    const received: string[] = [];
    const connectOnce = vi
      .fn<() => Promise<boolean>>()
      // First stream reaches EOF before its mandatory snapshot.
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async () => {
        received.push('snapshot', 'update');
        controller.abort();
        return true;
      });

    await runCanvasSyncReconnectLoop({
      signal: controller.signal,
      isActive: () => !controller.signal.aborted,
      connectOnce,
      wait: async () => undefined,
    });

    expect(connectOnce).toHaveBeenCalledTimes(2);
    expect(received).toEqual(['snapshot', 'update']);
  });

  it('backs off consecutive no-event streams and resets after a healthy one', async () => {
    const controller = new AbortController();
    const outcomes = [false, false, true, false];
    const delays: number[] = [];

    await runCanvasSyncReconnectLoop({
      signal: controller.signal,
      isActive: () => !controller.signal.aborted,
      connectOnce: async () => outcomes.shift() ?? false,
      wait: async (delayMs) => {
        delays.push(delayMs);
        if (delays.length === 4) controller.abort();
      },
      initialDelayMs: 100,
      maxDelayMs: 1_000,
    });

    expect(delays).toEqual([100, 200, 100, 100]);
  });
});
