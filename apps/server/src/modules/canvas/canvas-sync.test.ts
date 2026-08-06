// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect, vi } from 'vitest';

import { publishCanvasUpdate, subscribeCanvasUpdates } from './canvas-sync.js';

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
