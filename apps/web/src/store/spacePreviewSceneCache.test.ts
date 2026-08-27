// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getSpacePreviewScene: vi.fn(),
}));

vi.mock('@/api/canvas', () => api);

import {
  clearSpacePreviewSceneCache,
  getSpacePreviewSceneSnapshot,
  loadSpacePreviewScene,
} from './spacePreviewSceneCache';

import type { GetSpacePreviewSceneResponse } from '@huabu/shared';

function scene(canvasId: string): GetSpacePreviewSceneResponse {
  return {
    canvasId,
    title: canvasId,
    version: 1,
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    nodes: [],
    edges: [],
    truncated: { nodes: false, edges: false },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  clearSpacePreviewSceneCache();
  api.getSpacePreviewScene.mockReset();
});

describe('Space Preview scene cache', () => {
  it('deduplicates requests for one target', async () => {
    const pending = deferred<GetSpacePreviewSceneResponse>();
    api.getSpacePreviewScene.mockReturnValue(pending.promise);

    const first = loadSpacePreviewScene('canvas-a');
    const second = loadSpacePreviewScene('canvas-a');
    pending.resolve(scene('canvas-a'));
    await Promise.all([first, second]);

    expect(api.getSpacePreviewScene).toHaveBeenCalledTimes(1);
    expect(getSpacePreviewSceneSnapshot('canvas-a')).toMatchObject({
      scene: scene('canvas-a'),
      loading: false,
      stale: false,
      error: null,
    });
  });

  it('runs at most two target requests concurrently', async () => {
    const requests = [
      deferred<GetSpacePreviewSceneResponse>(),
      deferred<GetSpacePreviewSceneResponse>(),
      deferred<GetSpacePreviewSceneResponse>(),
    ];
    api.getSpacePreviewScene
      .mockReturnValueOnce(requests[0].promise)
      .mockReturnValueOnce(requests[1].promise)
      .mockReturnValueOnce(requests[2].promise);

    const loads = [
      loadSpacePreviewScene('canvas-a'),
      loadSpacePreviewScene('canvas-b'),
      loadSpacePreviewScene('canvas-c'),
    ];
    expect(api.getSpacePreviewScene).toHaveBeenCalledTimes(2);

    requests[0].resolve(scene('canvas-a'));
    await requests[0].promise;
    await vi.waitFor(() =>
      expect(api.getSpacePreviewScene).toHaveBeenCalledTimes(3),
    );
    requests[1].resolve(scene('canvas-b'));
    requests[2].resolve(scene('canvas-c'));
    await Promise.all(loads);
  });

  it('retains the last scene and marks it stale after refresh failure', async () => {
    api.getSpacePreviewScene.mockResolvedValueOnce(scene('canvas-a'));
    await loadSpacePreviewScene('canvas-a');
    api.getSpacePreviewScene.mockRejectedValueOnce(new Error('offline'));

    await loadSpacePreviewScene('canvas-a', true);

    expect(getSpacePreviewSceneSnapshot('canvas-a')).toMatchObject({
      scene: scene('canvas-a'),
      loading: false,
      stale: true,
      error: { message: 'offline' },
    });
  });

  it('drops cached scenes when the active workspace changes', async () => {
    api.getSpacePreviewScene.mockResolvedValueOnce(scene('canvas-a'));
    await loadSpacePreviewScene('canvas-a');

    window.dispatchEvent(new Event('workspace-changed'));

    expect(getSpacePreviewSceneSnapshot('canvas-a').scene).toBeNull();
  });
});
