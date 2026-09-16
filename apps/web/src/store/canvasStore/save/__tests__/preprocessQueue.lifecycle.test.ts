// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { preprocessNode } = vi.hoisted(() => ({ preprocessNode: vi.fn() }));
vi.mock('@/api', () => ({ preprocessNode }));
vi.mock('@/api/canvas', () => ({ preprocessNode }));

import { createPreprocessQueue } from '../preprocessQueue';

import type { NodeIngestionInfo } from '@/handler/canvasCommand/preprocess';
import type { Node } from '@xyflow/react';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const node: Node = {
  id: 'web-a',
  type: 'web',
  position: { x: 0, y: 0 },
  data: { src: 'https://example.com/a', content: '' },
};

function setup(nodes: Node[] = [node]) {
  const ingestion: Record<string, NodeIngestionInfo> = {};
  const blocked = new Set<string>();
  const state = {
    canvasId: 'canvas-a',
    nodes,
    setNodeIngestion: vi.fn((id: string, info: NodeIngestionInfo) => {
      ingestion[id] = info;
    }),
    clearNodeIngestion: vi.fn((id: string) => {
      delete ingestion[id];
    }),
    patchNodeSilent: vi.fn((id: string, patch: Record<string, unknown>) => {
      state.nodes = state.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, ...patch } } : n,
      );
    }),
  };
  const queue = createPreprocessQueue({
    delayMs: 100,
    getState: () => state,
    isBlocked: (id) => blocked.has(id),
  });
  return { state, ingestion, blocked, queue };
}

beforeEach(() => {
  vi.useFakeTimers();
  preprocessNode.mockReset().mockResolvedValue({ success: true });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('preprocessing task lifecycle', () => {
  it('preserves a protected rename while accepting otherwise current extraction', async () => {
    const { state, queue, ingestion } = setup();
    const result = deferred<{
      success: boolean;
      content: string;
      suggestedLabel: string;
    }>();
    preprocessNode.mockReturnValueOnce(result.promise);
    queue.schedule(node);
    await vi.advanceTimersByTimeAsync(100);
    state.nodes = [
      { ...node, data: { ...node.data, label: 'Manual', labelSource: 'user' } },
    ];
    result.resolve({
      success: true,
      content: 'Extracted body',
      suggestedLabel: 'Automatic',
    });
    await queue.waitForIdle();
    expect(state.nodes[0].data).toMatchObject({
      content: 'Extracted body',
      label: 'Manual',
      labelSource: 'user',
    });
    expect(ingestion[node.id]).toBeUndefined();
  });

  it('compares an issued input with restored state even when adjacent history inputs match', async () => {
    const note = { ...node, type: 'note', data: { content: '# A' } };
    const { state, queue, ingestion } = setup([note]);
    const old = deferred<{ success: boolean; suggestedLabel: string }>();
    preprocessNode.mockReturnValueOnce(old.promise);
    queue.schedule(note);
    await vi.advanceTimersByTimeAsync(100);
    // Typing does not issue another request until edit-settle.
    state.nodes = [{ ...note, data: { content: '# B' } }];
    const before = state.nodes;
    state.nodes = [{ ...state.nodes[0], position: { x: 20, y: 0 } }];
    queue.reconcileHistory(before);
    old.resolve({ success: true, suggestedLabel: 'A' });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.patchNodeSilent).not.toHaveBeenCalled();
    expect(ingestion[node.id]?.status).toBe('pending');
    await vi.advanceTimersByTimeAsync(100);
    expect(preprocessNode).toHaveBeenCalledTimes(2);
    expect(preprocessNode.mock.calls[1][2].snapshot.content).toBe('# B');
    expect(ingestion[node.id]).toBeUndefined();
  });

  it.each(['success', 'error'])(
    'rejects stale %s without history and waits for explicit settle',
    async (outcome) => {
      const note = { ...node, type: 'note', data: { content: '# A' } };
      const { state, queue, ingestion } = setup([note]);
      const old = deferred<{ success: boolean; suggestedLabel: string }>();
      preprocessNode.mockReturnValueOnce(old.promise);
      queue.schedule(note);
      await vi.advanceTimersByTimeAsync(100);
      state.nodes = [{ ...note, data: { content: '# B' } }];
      if (outcome === 'success')
        old.resolve({ success: true, suggestedLabel: 'A' });
      else old.reject(new Error('Obsolete failure'));
      await queue.waitForIdle();
      expect(state.patchNodeSilent).not.toHaveBeenCalled();
      expect(ingestion[node.id]).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(preprocessNode).toHaveBeenCalledOnce();
      queue.schedule(state.nodes[0]);
      await vi.advanceTimersByTimeAsync(100);
      expect(preprocessNode).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])(
    'retains demand when blocked at schedule or fire time (late=%s)',
    async (late) => {
      const { state, queue, blocked, ingestion } = setup();
      if (!late) blocked.add(node.id);
      queue.schedule(node);
      blocked.add(node.id);
      await vi.advanceTimersByTimeAsync(500);
      expect(preprocessNode).not.toHaveBeenCalled();
      state.nodes = [{ ...node, data: { src: 'https://example.com/latest' } }];
      queue.schedule(state.nodes[0]);
      queue.resumeRestored(state.canvasId, node.id);
      await vi.advanceTimersByTimeAsync(100);
      expect(preprocessNode).not.toHaveBeenCalled();
      expect(ingestion[node.id]?.status).toBe('pending');
      blocked.delete(node.id);
      queue.resumeRestored(state.canvasId, node.id);
      queue.resumeRestored(state.canvasId, node.id);
      await vi.advanceTimersByTimeAsync(100);
      expect(preprocessNode).toHaveBeenCalledOnce();
      expect(preprocessNode.mock.calls[0][2].snapshot.src).toBe(
        'https://example.com/latest',
      );
      expect(ingestion[node.id]).toBeUndefined();
    },
  );

  it('keeps blocked demand across delete/restore but never sends it while absent', async () => {
    const { state, queue, blocked } = setup();
    blocked.add(node.id);
    queue.schedule(node);
    state.nodes = [];
    queue.forgetNode(node.id);
    blocked.delete(node.id);
    queue.resumeRestored(state.canvasId, node.id);
    await vi.advanceTimersByTimeAsync(100);
    expect(preprocessNode).not.toHaveBeenCalled();
    state.nodes = [node];
    queue.reconcileHistory([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(preprocessNode).toHaveBeenCalledOnce();
  });

  it('cancels blocked demand on Canvas switch and ignores its late persistence callback', async () => {
    const { state, queue, blocked, ingestion } = setup();
    blocked.add(node.id);
    queue.schedule(node);
    queue.cancelAll();
    expect(ingestion[node.id]).toBeUndefined();
    state.canvasId = 'canvas-b';
    blocked.delete(node.id);
    queue.resumeRestored('canvas-a', node.id);
    await vi.advanceTimersByTimeAsync(100);
    expect(preprocessNode).not.toHaveBeenCalled();
  });

  it('lets an accepted canonical src/body/label update finish its own ingestion state', async () => {
    const { state, queue, ingestion } = setup();
    preprocessNode.mockResolvedValueOnce({
      success: true,
      src: 'artifact-canonical',
      content: 'Canonical body',
      suggestedLabel: 'Canonical label',
    });
    queue.schedule(node);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.nodes[0].data.src).toBe('artifact-canonical');
    expect(state.nodes[0].data.label).toBe('Canonical label');
    expect(ingestion[node.id]).toBeUndefined();
  });

  it.each([false, true])(
    'preserves unrelated and geometry-only undo (issued=%s)',
    async (issued) => {
      const other = { ...node, id: 'web-b' };
      const { state, queue, ingestion } = setup([node, other]);
      const gate = deferred<{ success: boolean; summary: string }>();
      preprocessNode.mockReturnValueOnce(gate.promise);
      queue.schedule(node);
      if (issued) await vi.advanceTimersByTimeAsync(100);
      const before = state.nodes;
      state.nodes = [
        { ...node, position: { x: 50, y: 30 }, data: { ...node.data } },
        { ...other, data: { src: 'https://example.com/changed' } },
      ];
      queue.reconcileHistory(before);
      expect(ingestion[node.id]?.status).toBe('pending');
      await vi.advanceTimersByTimeAsync(100);
      expect(preprocessNode).toHaveBeenCalledOnce();
      gate.resolve({ success: true, summary: 'Still useful' });
      await queue.waitForIdle();
      expect(state.nodes[0].data.summary).toBe('Still useful');
      expect(ingestion[node.id]).toBeUndefined();
    },
  );

  it.each(['success', 'error'])(
    'ignores old %s status and projection after rescheduling',
    async (outcome) => {
      const { state, queue, ingestion } = setup();
      const old = deferred<{ success: boolean; content: string }>();
      const fresh = deferred<{ success: boolean; content: string }>();
      preprocessNode
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(fresh.promise);
      queue.schedule(node);
      await vi.advanceTimersByTimeAsync(100);
      const before = state.nodes;
      state.nodes = [
        { ...node, data: { src: 'https://example.com/restored', content: '' } },
      ];
      queue.reconcileHistory(before);
      await vi.advanceTimersByTimeAsync(100);
      expect(preprocessNode.mock.calls[1][2].snapshot.src).toBe(
        'https://example.com/restored',
      );
      if (outcome === 'error') old.reject(new Error('Obsolete failure'));
      else old.resolve({ success: true, content: 'Obsolete content' });
      await vi.advanceTimersByTimeAsync(0);
      expect(ingestion[node.id]?.status).toBe('pending');
      expect(state.patchNodeSilent).not.toHaveBeenCalled();
      fresh.resolve({ success: true, content: 'Current content' });
      await queue.waitForIdle();
      expect(state.nodes[0].data.content).toBe('Current content');
      expect(ingestion[node.id]).toBeUndefined();
    },
  );

  it('invalidates a frame task when restored child labels change', async () => {
    const frame = { ...node, id: 'frame', type: 'frame', data: {} };
    const child = { ...node, parentId: frame.id, data: { label: 'Before' } };
    const { state, queue } = setup([frame, child]);
    queue.schedule(frame);
    const before = state.nodes;
    state.nodes = [frame, { ...child, data: { label: 'Restored' } }];
    queue.reconcileHistory(before);
    await vi.advanceTimersByTimeAsync(100);
    expect(preprocessNode).toHaveBeenCalledOnce();
    expect(preprocessNode.mock.calls[0][2].snapshot.childLabels).toEqual([
      'Restored',
    ]);
  });

  it.each([false, true])(
    'resumes unfinished deletion only after restore persistence (issued=%s)',
    async (issued) => {
      const { state, queue, ingestion, blocked } = setup();
      const old = deferred<{ success: boolean; content: string }>();
      if (issued) preprocessNode.mockReturnValueOnce(old.promise);
      queue.schedule(node);
      if (issued) await vi.advanceTimersByTimeAsync(100);
      state.nodes = [];
      queue.forgetNode(node.id);
      expect(ingestion[node.id]).toBeUndefined();
      blocked.add(node.id);
      state.nodes = [node];
      queue.reconcileHistory([]);
      await vi.advanceTimersByTimeAsync(100);
      expect(preprocessNode).toHaveBeenCalledTimes(issued ? 1 : 0);
      if (issued) {
        old.resolve({ success: true, content: 'Discarded before DELETE' });
        await queue.waitForIdle();
        expect(state.patchNodeSilent).not.toHaveBeenCalled();
      }
      blocked.delete(node.id);
      queue.resumeRestored(state.canvasId, node.id);
      queue.resumeRestored(state.canvasId, node.id);
      expect(ingestion[node.id]?.status).toBe('pending');
      await vi.advanceTimersByTimeAsync(100);
      expect(preprocessNode).toHaveBeenCalledTimes(issued ? 2 : 1);
      expect(ingestion[node.id]).toBeUndefined();
    },
  );

  it('does not reprocess completed work on deletion and resurrection', async () => {
    const { state, queue } = setup();
    queue.schedule(node);
    await vi.advanceTimersByTimeAsync(100);
    await queue.waitForIdle();
    state.nodes = [];
    queue.forgetNode(node.id);
    state.nodes = [node];
    queue.reconcileHistory([]);
    queue.resumeRestored(state.canvasId, node.id);
    await vi.advanceTimersByTimeAsync(100);
    expect(preprocessNode).toHaveBeenCalledOnce();
  });

  it('clears missing-node pending and remembers work even without a deletion notification', async () => {
    const { state, queue, ingestion } = setup();
    queue.schedule(node);
    state.nodes = [];
    await vi.advanceTimersByTimeAsync(100);
    expect(ingestion[node.id]).toBeUndefined();
    expect(preprocessNode).not.toHaveBeenCalled();
    state.nodes = [node];
    queue.reconcileHistory([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(preprocessNode).toHaveBeenCalledOnce();
  });

  it('clears cancellation status and ignores callbacks from a departed Canvas', async () => {
    const { state, queue, ingestion } = setup();
    const old = deferred<{ success: boolean; content: string }>();
    preprocessNode.mockReturnValueOnce(old.promise);
    queue.schedule(node);
    await vi.advanceTimersByTimeAsync(100);
    queue.cancelAll();
    expect(ingestion[node.id]).toBeUndefined();
    state.canvasId = 'canvas-b';
    ingestion[node.id] = { status: 'pending', updatedAt: 1 };
    old.reject(new Error('Previous Canvas failed'));
    await queue.waitForIdle();
    expect(ingestion[node.id]).toEqual({ status: 'pending', updatedAt: 1 });
    expect(state.patchNodeSilent).not.toHaveBeenCalled();
  });
});
