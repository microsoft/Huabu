// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect, vi } from 'vitest';

import { publishCanvasUpdate, subscribeCanvasUpdates } from './canvas-sync.js';
import { contentSavedSince, contentWatermark } from './content-watermark.js';
import { currentWorkspaceScope, runInWorkspace } from '../workspace/context.js';

import type { CanvasSyncEvent } from '@huabu/shared';

const update = (toVersion: number): CanvasSyncEvent => ({
  type: 'update',
  data: {
    fromVersion: toVersion - 1,
    toVersion,
    deltas: [],
    pendingEffects: {
      mutatedNodes: [],
      deletedNodeIds: [],
      contentEditedNodeIds: [],
      deferredFitFrameIds: [],
    },
  },
});

describe('canvas-sync publisher', () => {
  it("runs each listener in its subscriber's Workspace, not the writer's", () => {
    const scope = (workspaceId: string) => ({
      handle: { workspaceId, name: workspaceId },
      path: null,
    });
    const seen: Array<string | undefined> = [];
    const unsubscribe = runInWorkspace(scope('observer'), () =>
      subscribeCanvasUpdates('canvas-1', () =>
        seen.push(currentWorkspaceScope()?.handle.workspaceId),
      ),
    );
    runInWorkspace(scope('writer'), () =>
      publishCanvasUpdate('canvas-1', update(2)),
    );
    publishCanvasUpdate('canvas-1', update(3));
    expect(seen).toEqual(['observer', 'observer']);
    unsubscribe();
  });

  it('stamps a content save with its sequence and records it with nobody listening', () => {
    const before = contentWatermark();
    // No subscriber yet: the save is still recorded.
    publishCanvasUpdate('canvas-content', {
      type: 'invalidate',
      data: { nodeIds: ['n1'], originPageId: 'page-a' },
    });
    const listener = vi.fn();
    const unsubscribe = subscribeCanvasUpdates('canvas-content', listener);
    publishCanvasUpdate('canvas-content', {
      type: 'invalidate',
      data: { nodeIds: ['n2'] },
    });
    // A read-model notice names no node and is not a content save.
    publishCanvasUpdate('canvas-content', { type: 'invalidate', data: {} });

    expect(listener.mock.calls).toEqual([
      [
        {
          type: 'invalidate',
          data: { nodeIds: ['n2'], contentSeq: before.seq + 2 },
        },
      ],
      [{ type: 'invalidate', data: {} }],
    ]);
    expect(contentSavedSince('canvas-content', before)).toEqual(['n1', 'n2']);
    expect(contentWatermark().seq).toBe(before.seq + 2);
    unsubscribe();
  });

  it('delivers events to subscribers of the same canvas only', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeCanvasUpdates('canvas-1', a);
    const unsubB = subscribeCanvasUpdates('canvas-2', b);

    publishCanvasUpdate('canvas-1', update(2));

    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith(update(2));
    expect(b).not.toHaveBeenCalled();

    unsubA();
    unsubB();
  });

  it('fans out to multiple subscribers of one canvas', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeCanvasUpdates('canvas-1', a);
    const unsubB = subscribeCanvasUpdates('canvas-1', b);

    publishCanvasUpdate('canvas-1', update(3));

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    unsubA();
    unsubB();
  });

  it('stops delivering after unsubscribe', () => {
    const a = vi.fn();
    const unsub = subscribeCanvasUpdates('canvas-1', a);
    unsub();

    publishCanvasUpdate('canvas-1', update(2));

    expect(a).not.toHaveBeenCalled();
  });

  it('is a no-op when there are no subscribers', () => {
    expect(() => publishCanvasUpdate('nobody', update(2))).not.toThrow();
  });

  it('isolates one failing subscriber from the rest', () => {
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    const unsubBad = subscribeCanvasUpdates('canvas-1', bad);
    const unsubGood = subscribeCanvasUpdates('canvas-1', good);

    expect(() => publishCanvasUpdate('canvas-1', update(2))).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);

    unsubBad();
    unsubGood();
  });
});
