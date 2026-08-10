// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, it, expect, vi } from 'vitest';

import {
  __flushHeightCommitsNow,
  __resetHeightCommitQueue,
  cancelMeasuredHeight,
  proposeMeasuredHeight,
} from '../commitQueue';
import {
  __resetHeightCommitSuspension,
  cancelHeightCommitSuspensions,
  resumeHeightCommits,
  suspendHeightCommits,
} from '../commitSuspension';

import type { Node } from '@xyflow/react';

const applyMeasuredHeights = vi.fn();
let storeNodes: Node[] = [];

vi.mock('@/store/canvasStore', () => ({
  default: {
    getState: () => ({ nodes: storeNodes, applyMeasuredHeights }),
  },
}));

function note(overrides: Partial<Node> = {}): Node {
  return {
    id: 'n1',
    type: 'note',
    position: { x: 0, y: 0 },
    style: { width: 400, height: 264 },
    data: { type: 'note', heightMode: 'auto' },
    ...overrides,
  } as Node;
}

beforeEach(() => {
  applyMeasuredHeights.mockClear();
  __resetHeightCommitQueue();
  __resetHeightCommitSuspension();
  storeNodes = [note()];
});

describe('height commit queue — threshold', () => {
  it('collapses sub-quantization jitter to no write at all', () => {
    // Same content (same key), re-measured 2px taller. Both 256 and 258
    // resolve to a layout height of 264, which is what the node already
    // has — so quantization, not a tolerance, is what makes
    // ResizeObserver jitter free rather than merely cheap.
    storeNodes = [
      note({
        data: {
          type: 'note',
          heightMode: 'auto',
          autoHeight: { intrinsicHeight: 256, measuredFor: 'k1' },
        },
      }),
    ];
    proposeMeasuredHeight({
      nodeId: 'n1',
      intrinsicHeight: 258,
      measuredFor: 'k1',
    });
    __flushHeightCommitsNow();
    expect(applyMeasuredHeights).not.toHaveBeenCalled();
  });

  it('commits a real change', () => {
    proposeMeasuredHeight({
      nodeId: 'n1',
      intrinsicHeight: 400,
      measuredFor: 'k1',
    });
    __flushHeightCommitsNow();
    expect(applyMeasuredHeights).toHaveBeenCalledWith([
      { nodeId: 'n1', intrinsicHeight: 400, measuredFor: 'k1' },
    ]);
  });

  it('commits an unchanged height when the provenance moved', () => {
    // Content changed without changing the height. Skipping this would
    // leave the hint pointing at old content, so the node would be
    // re-measured on every load forever.
    storeNodes = [
      note({
        data: {
          type: 'note',
          heightMode: 'auto',
          autoHeight: { intrinsicHeight: 260, measuredFor: 'old-key' },
        },
      }),
    ];
    proposeMeasuredHeight({
      nodeId: 'n1',
      intrinsicHeight: 260,
      measuredFor: 'new-key',
    });
    __flushHeightCommitsNow();
    expect(applyMeasuredHeights).toHaveBeenCalledTimes(1);
  });

  it('skips a node the user pinned while the measurement was in flight', () => {
    // Nothing measured inside a box the user chose is a trustworthy
    // intrinsic height. `setNoteHeightMode` measures offscreen when a
    // pinned note needs one.
    proposeMeasuredHeight({
      nodeId: 'n1',
      intrinsicHeight: 400,
      measuredFor: 'k1',
    });
    storeNodes = [note({ data: { type: 'note', heightMode: 'fixed' } })];
    __flushHeightCommitsNow();
    expect(applyMeasuredHeights).not.toHaveBeenCalled();
  });

  it('drops a measurement for a type that never auto-sizes', () => {
    proposeMeasuredHeight({
      nodeId: 'n1',
      intrinsicHeight: 400,
      measuredFor: 'k1',
    });
    storeNodes = [note({ type: 'image', data: { type: 'image' } })];
    __flushHeightCommitsNow();
    expect(applyMeasuredHeights).not.toHaveBeenCalled();
  });

  it('skips a node that no longer exists', () => {
    proposeMeasuredHeight({
      nodeId: 'n1',
      intrinsicHeight: 400,
      measuredFor: 'k1',
    });
    storeNodes = [];
    __flushHeightCommitsNow();
    expect(applyMeasuredHeights).not.toHaveBeenCalled();
  });

  it('ignores a non-positive or non-finite measurement', () => {
    proposeMeasuredHeight({
      nodeId: 'n1',
      intrinsicHeight: 0,
      measuredFor: 'k',
    });
    proposeMeasuredHeight({
      nodeId: 'n1',
      intrinsicHeight: Number.NaN,
      measuredFor: 'k',
    });
    __flushHeightCommitsNow();
    expect(applyMeasuredHeights).not.toHaveBeenCalled();
  });
});

describe('height commit queue — coalescing', () => {
  it('keeps only the latest proposal per node', () => {
    proposeMeasuredHeight({
      nodeId: 'n1',
      intrinsicHeight: 400,
      measuredFor: 'k1',
    });
    proposeMeasuredHeight({
      nodeId: 'n1',
      intrinsicHeight: 500,
      measuredFor: 'k2',
    });
    __flushHeightCommitsNow();
    expect(applyMeasuredHeights).toHaveBeenCalledWith([
      { nodeId: 'n1', intrinsicHeight: 500, measuredFor: 'k2' },
    ]);
  });

  it('commits many nodes as one batch, so the frame refits once', () => {
    storeNodes = [note(), note({ id: 'n2' })];
    proposeMeasuredHeight({
      nodeId: 'n1',
      intrinsicHeight: 400,
      measuredFor: 'k1',
    });
    proposeMeasuredHeight({
      nodeId: 'n2',
      intrinsicHeight: 500,
      measuredFor: 'k2',
    });
    __flushHeightCommitsNow();
    expect(applyMeasuredHeights).toHaveBeenCalledTimes(1);
    expect(applyMeasuredHeights.mock.calls[0][0]).toHaveLength(2);
  });

  it('forgets a cancelled proposal', () => {
    proposeMeasuredHeight({
      nodeId: 'n1',
      intrinsicHeight: 400,
      measuredFor: 'k1',
    });
    cancelMeasuredHeight('n1');
    __flushHeightCommitsNow();
    expect(applyMeasuredHeights).not.toHaveBeenCalled();
  });
});

describe('height commit queue — gesture suspension', () => {
  it('holds corrections while a gesture is active and flushes once on settle', () => {
    suspendHeightCommits();
    proposeMeasuredHeight({
      nodeId: 'n1',
      intrinsicHeight: 400,
      measuredFor: 'k1',
    });
    proposeMeasuredHeight({
      nodeId: 'n1',
      intrinsicHeight: 500,
      measuredFor: 'k2',
    });
    __flushHeightCommitsNow();
    expect(applyMeasuredHeights).not.toHaveBeenCalled();

    resumeHeightCommits();
    __flushHeightCommitsNow();
    expect(applyMeasuredHeights).toHaveBeenCalledTimes(1);
    expect(applyMeasuredHeights).toHaveBeenCalledWith([
      { nodeId: 'n1', intrinsicHeight: 500, measuredFor: 'k2' },
    ]);
  });

  it('stays suspended until the outermost gesture ends', () => {
    suspendHeightCommits();
    suspendHeightCommits();
    proposeMeasuredHeight({
      nodeId: 'n1',
      intrinsicHeight: 400,
      measuredFor: 'k1',
    });

    resumeHeightCommits();
    __flushHeightCommitsNow();
    expect(applyMeasuredHeights).not.toHaveBeenCalled();

    resumeHeightCommits();
    __flushHeightCommitsNow();
    expect(applyMeasuredHeights).toHaveBeenCalledTimes(1);
  });

  it('treats duplicate starts for the same interaction as one hold', () => {
    suspendHeightCommits('viewport');
    suspendHeightCommits('viewport');
    proposeMeasuredHeight({
      nodeId: 'n1',
      intrinsicHeight: 400,
      measuredFor: 'k1',
    });

    resumeHeightCommits('viewport');
    __flushHeightCommitsNow();
    expect(applyMeasuredHeights).toHaveBeenCalledTimes(1);
  });

  it('does not release an active gesture based on elapsed time', () => {
    vi.useFakeTimers();
    suspendHeightCommits('node-drag');
    proposeMeasuredHeight({
      nodeId: 'n1',
      intrinsicHeight: 400,
      measuredFor: 'k1',
    });

    vi.advanceTimersByTime(60_000);
    __flushHeightCommitsNow();
    expect(applyMeasuredHeights).not.toHaveBeenCalled();

    resumeHeightCommits('node-drag');
    __flushHeightCommitsNow();
    expect(applyMeasuredHeights).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('flushes named holds after an explicit cancellation signal', () => {
    suspendHeightCommits('node-drag');
    proposeMeasuredHeight({
      nodeId: 'n1',
      intrinsicHeight: 400,
      measuredFor: 'k1',
    });

    cancelHeightCommitSuspensions();
    __flushHeightCommitsNow();
    expect(applyMeasuredHeights).toHaveBeenCalledTimes(1);
  });

  it('evaluates a held proposal against the state at settle time', () => {
    suspendHeightCommits();
    proposeMeasuredHeight({
      nodeId: 'n1',
      intrinsicHeight: 400,
      measuredFor: 'k1',
    });
    // Something else settled the node to this exact state during the
    // gesture, so by the time the queue drains there is nothing to do.
    storeNodes = [
      note({
        style: { width: 400, height: 400 },
        data: {
          type: 'note',
          heightMode: 'auto',
          autoHeight: { intrinsicHeight: 400, measuredFor: 'k1' },
        },
      }),
    ];
    resumeHeightCommits();
    __flushHeightCommitsNow();
    expect(applyMeasuredHeights).not.toHaveBeenCalled();
  });
});
