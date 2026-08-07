// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, it, expect, vi } from 'vitest';

import { HEIGHT_LAYOUT_VERSION } from '@huabu/shared/canvas-engine';
import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import {
  __resetHeightCommitSuspension,
  resumeHeightCommits,
  suspendHeightCommits,
} from '../../commitSuspension';
import {
  __resetHeightPrewarm,
  selectPrewarmCandidates,
  startHeightPrewarm,
} from '../prewarmQueue';

import type { Node } from '@xyflow/react';

const mocks = vi.hoisted(() => ({
  state: {
    nodes: [] as Node[],
    viewport: null,
    canvasId: 'canvas-test',
  },
  subscriber: null as (() => void) | null,
  measure: vi.fn(),
  propose: vi.fn(),
}));

vi.mock('@/store/canvasStore', () => ({
  default: {
    getState: () => mocks.state,
    subscribe: (subscriber: () => void) => {
      mocks.subscriber = subscriber;
      return () => {
        mocks.subscriber = null;
      };
    },
  },
}));
vi.mock('../offscreenMeasurer', () => ({
  measureNoteHeightOffscreen: mocks.measure,
  destroyOffscreenMeasurer: vi.fn(),
}));
vi.mock('../../commitQueue', () => ({
  proposeMeasuredHeight: mocks.propose,
}));

const CONTENT = '# hello';
const KEY = `${HEIGHT_LAYOUT_VERSION}:${nodeRevisionOf({ content: CONTENT })}`;
const ORIGIN = { x: 0, y: 0 };

function note(overrides: Partial<Node> = {}): Node {
  return {
    id: 'n1',
    type: 'note',
    position: { x: 0, y: 0 },
    style: { width: 400, height: 268 },
    data: { type: 'note', content: CONTENT, heightMode: 'auto' },
    ...overrides,
  } as Node;
}

afterEach(() => {
  __resetHeightPrewarm();
  __resetHeightCommitSuspension();
  vi.restoreAllMocks();
  mocks.state.nodes = [];
  mocks.measure.mockReset();
  mocks.propose.mockReset();
  vi.useRealTimers();
});

describe('selectPrewarmCandidates', () => {
  it('picks up a note that has never been measured', () => {
    const picked = selectPrewarmCandidates([note()], ORIGIN);
    expect(picked).toHaveLength(1);
    expect(picked[0]).toMatchObject({ nodeId: 'n1', markdown: CONTENT });
  });

  it('stamps the key of the content it is about to measure', () => {
    // Capturing the key up front is what stops a note edited mid-flight
    // from being stamped with provenance the measurement never saw.
    expect(selectPrewarmCandidates([note()], ORIGIN)[0].measuredFor).toBe(KEY);
  });

  it('skips a note whose stored hint is already current', () => {
    const measured = note({
      data: {
        type: 'note',
        content: CONTENT,
        heightMode: 'auto',
        autoHeight: { intrinsicHeight: 260, measuredFor: KEY },
      },
    });
    expect(selectPrewarmCandidates([measured], ORIGIN)).toHaveLength(0);
  });

  it('picks up a note whose content changed under a stored hint', () => {
    const stale = note({
      data: {
        type: 'note',
        content: '# rewritten by an agent',
        heightMode: 'auto',
        autoHeight: { intrinsicHeight: 260, measuredFor: KEY },
      },
    });
    expect(selectPrewarmCandidates([stale], ORIGIN)).toHaveLength(1);
  });

  it('skips notes the user pinned, and types that never auto-size', () => {
    const pinned = note({
      data: { type: 'note', content: CONTENT, heightMode: 'fixed' },
    });
    const image = note({ id: 'i1', type: 'image', data: { type: 'image' } });
    const text = note({
      id: 't1',
      type: 'text',
      data: { type: 'text', content: 'x' },
    });
    expect(selectPrewarmCandidates([pinned, image, text], ORIGIN)).toHaveLength(
      0,
    );
  });

  it('orders by distance from the viewport centre', () => {
    const near = note({ id: 'near', position: { x: 100, y: 0 } });
    const far = note({ id: 'far', position: { x: 5000, y: 0 } });
    expect(
      selectPrewarmCandidates([far, near], ORIGIN).map((c) => c.nodeId),
    ).toEqual(['near', 'far']);
  });

  it('puts never-measured notes ahead of stale ones, however distant', () => {
    // A missing hint means the node is sitting at its policy minimum,
    // which is the largest correction still outstanding.
    const staleNear = note({
      id: 'stale',
      position: { x: 10, y: 0 },
      data: {
        type: 'note',
        content: '# changed',
        heightMode: 'auto',
        autoHeight: { intrinsicHeight: 260, measuredFor: KEY },
      },
    });
    const missingFar = note({ id: 'missing', position: { x: 9000, y: 0 } });
    expect(
      selectPrewarmCandidates([staleNear, missingFar], ORIGIN).map(
        (c) => c.nodeId,
      ),
    ).toEqual(['missing', 'stale']);
  });

  it('does not re-offer a node already attempted under the same key', () => {
    const attempts = new Set([`n1:${KEY}`]);
    expect(selectPrewarmCandidates([note()], ORIGIN, attempts)).toHaveLength(0);
  });
});

describe('height prewarm recovery', () => {
  it('retries a transient measurement failure and commits the result', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.state.nodes = [note()];
    const error = new Error('transient editor failure');
    mocks.measure
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ height: 320, provisional: false });

    startHeightPrewarm();
    await vi.advanceTimersByTimeAsync(2500);

    expect(mocks.measure).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      '[height] offscreen note measurement failed; retrying',
      {
        nodeId: 'n1',
        measuredFor: KEY,
        attempt: 1,
        retryInMs: 1000,
        error,
      },
    );
    expect(mocks.propose).toHaveBeenCalledWith({
      nodeId: 'n1',
      intrinsicHeight: 320,
      measuredFor: KEY,
      provisional: false,
    });
  });

  it('retries when a measured proposal does not produce a stored hint', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.state.nodes = [note()];
    mocks.measure.mockResolvedValue({ height: 320, provisional: false });
    mocks.propose
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        mocks.state.nodes = [
          note({
            data: {
              type: 'note',
              content: CONTENT,
              heightMode: 'auto',
              autoHeight: { intrinsicHeight: 320, measuredFor: KEY },
            },
          }),
        ];
      });

    startHeightPrewarm();
    await vi.advanceTimersByTimeAsync(3500);

    expect(mocks.measure).toHaveBeenCalledTimes(2);
    expect(mocks.propose).toHaveBeenCalledTimes(2);
  });

  it('does not confirm or retry a proposal while commits are suspended', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.state.nodes = [note()];
    mocks.measure.mockResolvedValue({ height: 320, provisional: false });
    suspendHeightCommits('node-drag');

    startHeightPrewarm();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mocks.measure).toHaveBeenCalledTimes(1);
    expect(mocks.propose).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();

    resumeHeightCommits('node-drag');
    await vi.advanceTimersByTimeAsync(2500);
    expect(mocks.measure).toHaveBeenCalledTimes(2);
  });
});
