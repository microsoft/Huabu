// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { preprocessNodeIfNeeded, preprocessNode } = vi.hoisted(() => ({
  preprocessNodeIfNeeded: vi.fn(),
  preprocessNode: vi.fn(),
}));

vi.mock('@/api', () => ({
  preprocessNode,
}));

vi.mock('@/handler/canvasCommand/preprocess', () => ({
  buildPreprocessSnapshot: vi.fn(),
  preprocessNodeIfNeeded,
}));

import { createPreprocessQueue } from '../preprocessQueue';

import type { Node } from '@xyflow/react';

describe('preprocessQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    preprocessNodeIfNeeded.mockReset().mockResolvedValue(undefined);
    preprocessNode.mockReset().mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['spacePreview', 'sketch'])(
    'never schedules, requests, or changes ingestion for %s',
    async (type) => {
      const node: Node = {
        id: 'excluded-1',
        type,
        position: { x: 0, y: 0 },
        data: {},
      };
      const setNodeIngestion = vi.fn();
      const clearNodeIngestion = vi.fn();
      const patchNodeSilent = vi.fn();
      const queue = createPreprocessQueue({
        delayMs: 1_000,
        getState: () => ({
          canvasId: 'canvas-1',
          nodes: [node],
          setNodeIngestion,
          clearNodeIngestion,
          patchNodeSilent,
        }),
      });

      queue.schedule(node);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      queue.schedule(node);
      queue.flushKeepalive();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(preprocessNodeIfNeeded).not.toHaveBeenCalled();
      expect(preprocessNode).not.toHaveBeenCalled();
      expect(setNodeIngestion).not.toHaveBeenCalled();
      expect(clearNodeIngestion).not.toHaveBeenCalled();
      expect(patchNodeSilent).not.toHaveBeenCalled();
    },
  );

  it.each(['spacePreview', 'sketch'])(
    'rechecks %s exclusion before delayed and keepalive requests',
    async (type) => {
      const node: Node = {
        id: 'changed-1',
        type: 'note',
        position: { x: 0, y: 0 },
        data: { content: 'Original note' },
      };
      let nodes = [node];
      const setNodeIngestion = vi.fn();
      const clearNodeIngestion = vi.fn();
      const queue = createPreprocessQueue({
        delayMs: 1_000,
        getState: () => ({
          canvasId: 'canvas-1',
          nodes,
          setNodeIngestion,
          clearNodeIngestion,
          patchNodeSilent: vi.fn(),
        }),
      });

      queue.schedule(node);
      nodes = [{ ...node, type }];
      await vi.advanceTimersByTimeAsync(1_000);
      expect(clearNodeIngestion).toHaveBeenCalledWith(node.id);
      expect(setNodeIngestion).toHaveBeenCalledTimes(1);
      expect(preprocessNodeIfNeeded).not.toHaveBeenCalled();

      nodes = [node];
      queue.schedule(node);
      nodes = [{ ...node, type }];
      queue.flushKeepalive();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(preprocessNode).not.toHaveBeenCalled();
      expect(preprocessNodeIfNeeded).not.toHaveBeenCalled();
      expect(setNodeIngestion).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    'note',
    'text',
    'question',
    'web',
    'pdf',
    'office',
    'image',
    'video',
    'frame',
  ])('preserves delayed and keepalive preprocessing for %s', async (type) => {
    const node: Node = {
      id: 'ordinary-1',
      type,
      position: { x: 0, y: 0 },
      data: { content: 'Content', src: 'artifact-source' },
    };
    const setNodeIngestion = vi.fn();
    const queue = createPreprocessQueue({
      delayMs: 1_000,
      getState: () => ({
        canvasId: 'canvas-1',
        nodes: [node],
        setNodeIngestion,
        clearNodeIngestion: vi.fn(),
        patchNodeSilent: vi.fn(),
      }),
    });

    queue.schedule(node);
    expect(setNodeIngestion).toHaveBeenCalledWith(node.id, {
      status: 'pending',
      updatedAt: expect.any(Number),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(preprocessNodeIfNeeded).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ node, canvasId: 'canvas-1' }),
    );

    queue.schedule(node);
    queue.flushKeepalive();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(preprocessNode).toHaveBeenCalledExactlyOnceWith(
      'canvas-1',
      node.id,
      expect.objectContaining({ nodeType: type, trigger: 'flush' }),
      { keepalive: true },
    );
    expect(preprocessNodeIfNeeded).toHaveBeenCalledOnce();
  });

  it('marks ingestion pending before the debounce fires', async () => {
    const node: Node = {
      id: 'web-1',
      type: 'web',
      position: { x: 0, y: 0 },
      data: { src: 'https://example.com' },
    };
    const setNodeIngestion = vi.fn();
    const queue = createPreprocessQueue({
      delayMs: 1_000,
      getState: () => ({
        canvasId: 'canvas-1',
        nodes: [node],
        setNodeIngestion,
        clearNodeIngestion: vi.fn(),
        patchNodeSilent: vi.fn(),
      }),
    });

    queue.schedule(node);

    expect(setNodeIngestion).toHaveBeenCalledWith('web-1', {
      status: 'pending',
      updatedAt: expect.any(Number),
    });
    expect(preprocessNodeIfNeeded).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(preprocessNodeIfNeeded).toHaveBeenCalledOnce();
  });

  it('keeps ingestion pending throughout the debounce window before firing', async () => {
    const node: Node = {
      id: 'web-2',
      type: 'web',
      position: { x: 0, y: 0 },
      data: { src: 'https://example.com' },
    };
    const setNodeIngestion = vi.fn();
    const clearNodeIngestion = vi.fn();
    const queue = createPreprocessQueue({
      delayMs: 1_000,
      getState: () => ({
        canvasId: 'canvas-1',
        nodes: [node],
        setNodeIngestion,
        clearNodeIngestion,
        patchNodeSilent: vi.fn(),
      }),
    });

    queue.schedule(node);

    // Marked pending up-front (once) so preview consumers stop
    // requesting server-persisted content during the debounce wait.
    expect(setNodeIngestion).toHaveBeenCalledTimes(1);
    expect(setNodeIngestion).toHaveBeenLastCalledWith('web-2', {
      status: 'pending',
      updatedAt: expect.any(Number),
    });

    // Midway through the window the node is still pending: nothing
    // cleared it and the debounced POST has not fired yet.
    await vi.advanceTimersByTimeAsync(500);
    expect(clearNodeIngestion).not.toHaveBeenCalled();
    expect(preprocessNodeIfNeeded).not.toHaveBeenCalled();

    // The debounced preprocess only runs at the end of the window.
    await vi.advanceTimersByTimeAsync(500);
    expect(preprocessNodeIfNeeded).toHaveBeenCalledOnce();
  });

  it('collapses rapid re-edits into one fire while re-marking pending', async () => {
    const node: Node = {
      id: 'web-3',
      type: 'web',
      position: { x: 0, y: 0 },
      data: { src: 'https://example.com' },
    };
    const setNodeIngestion = vi.fn();
    const queue = createPreprocessQueue({
      delayMs: 1_000,
      getState: () => ({
        canvasId: 'canvas-1',
        nodes: [node],
        setNodeIngestion,
        clearNodeIngestion: vi.fn(),
        patchNodeSilent: vi.fn(),
      }),
    });

    // Two edits inside one debounce window: each re-marks pending, but
    // the trailing timer collapses them into a single preprocess call.
    queue.schedule(node);
    await vi.advanceTimersByTimeAsync(400);
    queue.schedule(node);

    expect(setNodeIngestion).toHaveBeenCalledTimes(2);
    expect(preprocessNodeIfNeeded).not.toHaveBeenCalled();

    // The window restarts from the second schedule, so only after a
    // further 1_000ms does the single collapsed POST fire.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(preprocessNodeIfNeeded).toHaveBeenCalledOnce();
  });

  it('does not schedule preprocessing for a missing sidecar', async () => {
    const node: Node = {
      id: 'note-missing',
      type: 'note',
      position: { x: 0, y: 0 },
      data: { contentMissing: true },
    };
    const setNodeIngestion = vi.fn();
    const queue = createPreprocessQueue({
      delayMs: 1_000,
      getState: () => ({
        canvasId: 'canvas-1',
        nodes: [node],
        setNodeIngestion,
        clearNodeIngestion: vi.fn(),
        patchNodeSilent: vi.fn(),
      }),
    });

    queue.schedule(node);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(setNodeIngestion).not.toHaveBeenCalled();
    expect(preprocessNodeIfNeeded).not.toHaveBeenCalled();
  });

  it('surfaces unexpected helper rejection without leaving a rejected cleanup promise', async () => {
    const node: Node = {
      id: 'unexpected-failure',
      type: 'web',
      position: { x: 0, y: 0 },
      data: { src: 'https://example.com' },
    };
    const setNodeIngestion = vi.fn();
    const queue = createPreprocessQueue({
      delayMs: 1_000,
      getState: () => ({
        canvasId: 'canvas-1',
        nodes: [node],
        setNodeIngestion,
        clearNodeIngestion: vi.fn(),
        patchNodeSilent: vi.fn(),
      }),
    });
    preprocessNodeIfNeeded.mockRejectedValueOnce(
      new Error('Unexpected helper error'),
    );
    queue.schedule(node);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(queue.waitForIdle()).resolves.toBeUndefined();
    expect(setNodeIngestion).toHaveBeenLastCalledWith(node.id, {
      status: 'error',
      updatedAt: expect.any(Number),
      error: 'Unexpected helper error',
    });
  });

  it('cancels a pending preprocess when the sidecar becomes missing', async () => {
    const node: Node = {
      id: 'note-removed-during-debounce',
      type: 'note',
      position: { x: 0, y: 0 },
      data: {},
    };
    let nodes: Node[] = [node];
    const clearNodeIngestion = vi.fn();
    const queue = createPreprocessQueue({
      delayMs: 1_000,
      getState: () => ({
        canvasId: 'canvas-1',
        nodes,
        setNodeIngestion: vi.fn(),
        clearNodeIngestion,
        patchNodeSilent: vi.fn(),
      }),
    });

    queue.schedule(node);
    nodes = [{ ...node, data: { contentMissing: true } }];
    await vi.advanceTimersByTimeAsync(1_000);

    expect(preprocessNodeIfNeeded).not.toHaveBeenCalled();
    expect(clearNodeIngestion).toHaveBeenCalledWith(node.id);
  });
});
