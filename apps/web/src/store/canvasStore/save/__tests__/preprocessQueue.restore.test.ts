// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { preprocessNode, putNodeContent } = vi.hoisted(() => ({
  preprocessNode: vi.fn(),
  putNodeContent: vi.fn(),
}));
vi.mock('@/api', () => ({ preprocessNode }));
vi.mock('@/api/canvas', async (actual) => ({
  ...(await actual<typeof canvasApiModule>()),
  preprocessNode,
  putNodeContent,
}));

import { createNodeContentQueue } from '../nodeContentQueue';
import { createPreprocessQueue } from '../preprocessQueue';

import type * as canvasApiModule from '@/api/canvas';
import type { Node } from '@xyflow/react';

describe('preprocess restore projection generation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    putNodeContent.mockResolvedValue({
      nodeId: 'office-1',
      label: null,
      rev: 'restored',
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('rejects an old response even after the actual restore barrier is acknowledged and drained', async () => {
    const node: Node = {
      id: 'office-1',
      type: 'office',
      position: { x: 0, y: 0 },
      data: { content: 'Before restore', src: 'artifact-before.docx' },
    };
    const state = {
      canvasId: 'canvas-1',
      nodes: [node],
      setNodeIngestion: vi.fn(),
      clearNodeIngestion: vi.fn(),
      _setStateNoAutosave: vi.fn(),
      patchNodeSilent: vi.fn((id: string, patch: Record<string, unknown>) => {
        state.nodes = state.nodes.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, ...patch } } : n,
        );
      }),
    };
    const contentQueue = createNodeContentQueue({
      delayMs: 10,
      getState: () => state,
    });
    const queue = createPreprocessQueue({
      delayMs: 10,
      getState: () => state,
      isBlocked: (id) => contentQueue.hasRestore(id),
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const response = {
      success: true,
      content: 'Extracted body',
      src: 'artifact-extracted.docx',
      suggestedLabel: 'Extracted label',
      summary: 'Summary',
      keywords: ['keyword'],
    };
    preprocessNode.mockImplementationOnce(async () => {
      await gate;
      return response;
    });
    queue.schedule(node);
    await vi.advanceTimersByTimeAsync(10);
    expect(preprocessNode).toHaveBeenCalledOnce();

    // Exercise the barrier independently of the store's stronger DELETE wait.
    queue.cancelAll();
    const restored = {
      ...node,
      data: { content: 'Restored body', src: 'artifact-restored.docx' },
    };
    contentQueue.holdRestoredNodes(state.canvasId, [restored]);
    state.nodes = [restored];
    queue.schedule(restored);
    expect(contentQueue.hasRestore(node.id)).toBe(true);
    contentQueue.acknowledgeRestores(
      state.canvasId,
      contentQueue.restoreTokens(),
    );
    await contentQueue.flushAll();
    expect(contentQueue.hasRestore(node.id)).toBe(false);
    expect(contentQueue.hasPendingRestoredContent()).toBe(false);
    expect(putNodeContent).toHaveBeenCalledExactlyOnceWith(
      state.canvasId,
      node.id,
      expect.objectContaining({
        content: 'Restored body',
        src: 'artifact-restored.docx',
      }),
      undefined,
    );

    let idle = false;
    const waiting = queue.waitForIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    release();
    await waiting;
    expect(state.patchNodeSilent).not.toHaveBeenCalled();
    expect(state.nodes[0].data).toEqual(restored.data);

    preprocessNode.mockResolvedValueOnce(response);
    queue.schedule(restored);
    await vi.advanceTimersByTimeAsync(10);
    await queue.waitForIdle();
    expect(preprocessNode).toHaveBeenCalledTimes(2);
    expect(state.nodes[0].data).toEqual({
      content: response.content,
      src: response.src,
      label: response.suggestedLabel,
      labelSource: 'auto',
      summary: response.summary,
      keywords: response.keywords,
    });

    queue.schedule(state.nodes[0]);
    queue.cancelAll();
    queue.flushKeepalive();
    await vi.advanceTimersByTimeAsync(10);
    expect(preprocessNode).toHaveBeenCalledTimes(2);
  });
});
