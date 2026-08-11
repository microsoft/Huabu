// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { preprocessNodeIfNeeded } = vi.hoisted(() => ({
  preprocessNodeIfNeeded: vi.fn(),
}));

vi.mock('@/api', () => ({
  preprocessNode: vi.fn(),
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
    preprocessNodeIfNeeded.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('cancels a pending preprocess when the sidecar becomes missing', async () => {
    const node: Node = {
      id: 'note-removed-during-debounce',
      type: 'note',
      position: { x: 0, y: 0 },
      data: {},
    };
    let nodes: Node[] = [node];
    const queue = createPreprocessQueue({
      delayMs: 1_000,
      getState: () => ({
        canvasId: 'canvas-1',
        nodes,
        setNodeIngestion: vi.fn(),
        clearNodeIngestion: vi.fn(),
        patchNodeSilent: vi.fn(),
      }),
    });

    queue.schedule(node);
    nodes = [{ ...node, data: { contentMissing: true } }];
    await vi.advanceTimersByTimeAsync(1_000);

    expect(preprocessNodeIfNeeded).not.toHaveBeenCalled();
  });

  it('holds a new-node preprocess until its aggregate create is released', async () => {
    const node: Node = {
      id: 'note-new',
      type: 'note',
      position: { x: 0, y: 0 },
      data: { content: 'initial' },
    };
    let createPending = true;
    const queue = createPreprocessQueue({
      delayMs: 1_000,
      shouldDeferNode: () => createPending,
      getState: () => ({
        canvasId: 'canvas-1',
        nodes: [node],
        setNodeIngestion: vi.fn(),
        clearNodeIngestion: vi.fn(),
        patchNodeSilent: vi.fn(),
      }),
    });

    queue.schedule(node);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(preprocessNodeIfNeeded).not.toHaveBeenCalled();

    createPending = false;
    queue.releaseDeferred(node.id);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(preprocessNodeIfNeeded).toHaveBeenCalledOnce();
  });

  it('forgets held preprocessing when a new node is deleted before ACK', async () => {
    const node: Node = {
      id: 'note-deleted',
      type: 'note',
      position: { x: 0, y: 0 },
      data: { content: 'temporary' },
    };
    let nodes: Node[] = [node];
    let createPending = true;
    const clearNodeIngestion = vi.fn();
    const queue = createPreprocessQueue({
      delayMs: 1_000,
      shouldDeferNode: () => createPending,
      getState: () => ({
        canvasId: 'canvas-1',
        nodes,
        setNodeIngestion: vi.fn(),
        clearNodeIngestion,
        patchNodeSilent: vi.fn(),
      }),
    });

    queue.schedule(node);
    nodes = [];
    queue.forgetNode(node.id);
    createPending = false;
    queue.releaseDeferred(node.id);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(clearNodeIngestion).toHaveBeenCalledWith(node.id);
    expect(preprocessNodeIfNeeded).not.toHaveBeenCalled();
  });
});
