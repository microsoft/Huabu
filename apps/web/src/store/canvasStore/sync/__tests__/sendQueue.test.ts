// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/_client';

import {
  createSendQueue,
  isRetryableSendError,
  type SendOutcome,
  type SendQueueEntry,
} from '../sendQueue';

import type {
  CanvasCommand,
  PostCanvasExecuteRequest,
  PostCanvasExecuteResponse,
} from '@huabu/shared';

const move = (x: number): CanvasCommand =>
  ({
    type: 'SET_NODE_GEOMETRY',
    items: [{ nodeId: 'node-x', position: { x, y: 0 } }],
  }) as CanvasCommand;

function response(
  request: PostCanvasExecuteRequest,
  version: number,
): PostCanvasExecuteResponse {
  return {
    canvasId: 'space',
    fromVersion: version,
    toVersion: version + 1,
    deltas: [],
    results: request.commands.map((command) => ({ command, applied: true })),
    commands: request.commands,
    pendingEffects: {
      mutatedNodes: [],
      deletedNodeIds: [],
      contentEditedNodeIds: [],
      deferredFitFrameIds: [],
    },
    operationId: request.operationId,
  };
}

interface Call {
  request: PostCanvasExecuteRequest;
  keepalive: boolean;
  resolve: (value: PostCanvasExecuteResponse) => void;
  reject: (error: unknown) => void;
}

function harness(
  retry = {
    baseDelayMs: 100,
    maxDelayMs: 400,
    maxAttempts: 3,
    maxElapsedMs: 60_000,
  },
) {
  const calls: Call[] = [];
  const settled: Array<{ id: string; outcome: SendOutcome }> = [];
  let nextId = 0;
  const queue = createSendQueue({
    clientId: 'page-a',
    createId: () => `op-${++nextId}`,
    retry,
    maxBatchCommands: 3,
    send: (_canvasId, request, options) =>
      new Promise((resolve, reject) => {
        calls.push({
          request: structuredClone(request),
          keepalive: options?.keepalive === true,
          resolve,
          reject,
        });
      }),
    onSettled: (entry: SendQueueEntry, outcome) =>
      settled.push({ id: entry.id, outcome }),
  });
  const flush = () => vi.advanceTimersByTimeAsync(0);
  return { queue, calls, settled, flush };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('send queue', () => {
  it('sends one request at a time, in order, each with its own request id', async () => {
    const { queue, calls, settled, flush } = harness();
    queue.enqueue('space', [move(1)]);
    queue.enqueue('space', [move(2)]);
    expect(calls).toHaveLength(1);
    expect(calls[0].request).toMatchObject({
      operationId: 'op-1',
      originator: { source: 'ui', tabId: 'page-a' },
      commands: [move(1)],
    });
    expect(calls[0].request).not.toHaveProperty('basis');
    expect(queue.status('space')).toMatchObject({
      phase: 'sending',
      pending: 2,
    });

    calls[0].resolve(response(calls[0].request, 1));
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1].request.operationId).toBe('op-2');
    calls[1].resolve(response(calls[1].request, 2));
    await flush();

    expect(settled.map((entry) => entry.id)).toEqual(['op-1', 'op-2']);
    expect(settled.every(({ outcome }) => outcome.kind === 'response')).toBe(
      true,
    );
    expect(queue.status('space')).toMatchObject({ phase: 'idle', pending: 0 });
    expect(queue.isOwn('op-1')).toBe(true);
    expect(queue.isOwn('someone-else')).toBe(false);
  });

  it('repeats a failed request with the same request id', async () => {
    const { queue, calls, settled } = harness();
    queue.enqueue('space', [move(1)]);
    calls[0].reject(new TypeError('Failed to fetch'));
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.status('space').phase).toBe('retrying');
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(2);
    expect(calls[1].request).toEqual(calls[0].request);

    // The server answers the repeat from its stored result.
    calls[1].resolve({ ...response(calls[1].request, 1), replayed: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveLength(1);
    expect(settled[0].outcome.kind).toBe('response');
    expect(queue.status('space').phase).toBe('idle');
  });

  it('retries an unknown outcome and a lapsed session, not a refusal', () => {
    expect(isRetryableSendError(new TypeError('Failed to fetch'))).toBe(true);
    expect(
      isRetryableSendError(
        new ApiError(503, { code: 'operation-outcome-unknown' }, ''),
      ),
    ).toBe(true);
    expect(isRetryableSendError(new ApiError(401, {}, ''))).toBe(true);
    expect(isRetryableSendError(new ApiError(429, {}, ''))).toBe(true);
    expect(isRetryableSendError(new ApiError(400, {}, ''))).toBe(false);
    expect(isRetryableSendError(new ApiError(403, {}, ''))).toBe(false);
    expect(
      isRetryableSendError(
        new ApiError(409, { code: 'operation-id-reused' }, ''),
      ),
    ).toBe(false);
  });

  it('fails a refused request once and moves on to the next', async () => {
    const { queue, calls, settled, flush } = harness();
    queue.enqueue('space', [move(1)]);
    queue.enqueue('space', [move(2)]);
    calls[0].reject(new ApiError(403, { message: 'read-only' }, ''));
    await flush();
    expect(settled[0]).toMatchObject({
      id: 'op-1',
      outcome: { kind: 'failed', sent: true },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].request.commands).toEqual([move(2)]);
  });

  it('stalls after the attempt limit and resumes on request', async () => {
    const { queue, calls, settled, flush } = harness();
    const idle = queue.whenIdle('space');
    queue.enqueue('space', [move(1)]);
    const waiting = queue.whenIdle('space');
    await expect(idle).resolves.toBe('idle');

    calls[0].reject(new TypeError('offline'));
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    calls[1].reject(new TypeError('offline'));
    await flush();
    await vi.advanceTimersByTimeAsync(200);
    calls[2].reject(new TypeError('offline'));
    await flush();

    expect(queue.status('space')).toMatchObject({
      phase: 'stalled',
      pending: 1,
    });
    await expect(waiting).resolves.toBe('stalled');
    // Nothing is dropped and nothing more is sent on its own.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(3);
    expect(settled).toHaveLength(0);

    queue.resume('space');
    expect(calls).toHaveLength(4);
    expect(calls[3].request.operationId).toBe('op-1');
    calls[3].resolve(response(calls[3].request, 1));
    await flush();
    expect(settled[0].outcome.kind).toBe('response');
    expect(queue.status('space').phase).toBe('idle');
  });

  it('retries at once on request without forgetting the failures so far', async () => {
    const { queue, calls, flush } = harness();
    queue.enqueue('space', [move(1)]);
    calls[0].reject(new TypeError('offline'));
    await flush();
    expect(queue.status('space')).toMatchObject({
      phase: 'retrying',
      failures: 1,
    });

    // The backoff is cut short; the count is kept.
    queue.retryNow('space');
    await flush();
    expect(calls).toHaveLength(2);
    expect(queue.status('space').failures).toBe(1);
    calls[1].reject(new TypeError('offline'));
    await flush();
    queue.retryNow('space');
    await flush();
    calls[2].reject(new TypeError('offline'));
    await flush();
    expect(queue.status('space').phase).toBe('stalled');

    // A stalled lane is the user's to resume.
    queue.retryNow('space');
    await flush();
    expect(calls).toHaveLength(3);
    expect(queue.status('space').phase).toBe('stalled');
  });

  it('gives up derived reports at the limit instead of stalling', async () => {
    const { queue, calls, settled, flush } = harness();
    queue.enqueue('space', [move(1)], { derived: true });
    expect(queue.hasPending('space')).toBe(true);
    expect(queue.hasUserPending('space')).toBe(false);
    expect(queue.status('space')).toMatchObject({
      pending: 1,
      derivedPending: 1,
    });
    for (const delay of [100, 200, 0]) {
      calls.at(-1)?.reject(new TypeError('offline'));
      await flush();
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(calls).toHaveLength(3);
    expect(queue.status('space')).toMatchObject({
      phase: 'idle',
      pending: 0,
      failures: 0,
    });
    expect(settled).toEqual([
      {
        id: 'op-1',
        outcome: { kind: 'failed', error: expect.any(TypeError), sent: false },
      },
    ]);
  });

  it("stalls when a user's edit waits behind a failing derived report", async () => {
    const { queue, calls, settled, flush } = harness();
    queue.enqueue('space', [move(1)], { derived: true });
    await flush();
    queue.enqueue('space', [move(2)]);
    expect(queue.hasUserPending('space')).toBe(true);
    for (const delay of [100, 200, 0]) {
      calls.at(-1)?.reject(new TypeError('offline'));
      await flush();
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(queue.status('space')).toMatchObject({
      phase: 'stalled',
      pending: 2,
      derivedPending: 1,
    });
    expect(settled).toHaveLength(0);
  });

  it("an entry that folds a user's edit into a derived report is the user's", () => {
    const { queue } = harness();
    queue.enqueue('space', [move(1)]);
    const report = queue.enqueue('space', [move(2)], { derived: true });
    expect(report.entry.derived).toBe(true);
    const edit = queue.enqueue('space', [move(3)]);
    expect(edit.entry).toBe(report.entry);
    expect(edit.entry.derived).toBe(false);
    expect(queue.status('space').derivedPending).toBe(0);
  });

  it('stalls once the total retry time is used up', async () => {
    const { queue, calls, flush } = harness({
      baseDelayMs: 100,
      maxDelayMs: 100,
      maxAttempts: 1_000,
      maxElapsedMs: 250,
    });
    queue.enqueue('space', [move(1)]);
    for (let attempt = 0; attempt < 6; attempt++) {
      if (queue.status('space').phase === 'stalled') break;
      calls[attempt]?.reject(new TypeError('offline'));
      await flush();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(queue.status('space').phase).toBe('stalled');
    expect(calls.length).toBeLessThan(6);
  });

  it('folds edits made while a request is on the wire into one batch', async () => {
    const { queue, calls, flush } = harness();
    const first = queue.enqueue('space', [move(1)]);
    const second = queue.enqueue('space', [move(2)]);
    const third = queue.enqueue('space', [move(3)]);
    expect(first.entry).not.toBe(second.entry);
    expect(third.entry).toBe(second.entry);
    expect([second.offset, third.offset]).toEqual([0, 1]);

    // The merged batch is capped; a longer run starts another entry.
    queue.enqueue('space', [move(4)]);
    const overflow = queue.enqueue('space', [move(5)]);
    expect(overflow.entry).not.toBe(second.entry);
    expect(overflow.offset).toBe(0);

    calls[0].resolve(response(calls[0].request, 1));
    await flush();
    expect(calls[1].request.commands).toEqual([move(2), move(3), move(4)]);
  });

  it('sends each folded batch as a run with the read version it was made on', async () => {
    const { queue, calls, flush } = harness();
    queue.enqueue('space', [move(1)]);
    // No read version stated: the request carries no runs.
    expect(calls[0].request).not.toHaveProperty('runs');
    queue.enqueue('space', [move(2), move(3)], { run: { basis: 'b-1' } });
    queue.enqueue('space', [move(4)], {
      run: {
        basis: 'b-2',
        after: [
          { entryId: 'op-1', start: 0, count: 1 },
          { entryId: 'op-2', start: 0, count: 2 },
        ],
      },
    });
    calls[0].resolve(response(calls[0].request, 1));
    await flush();
    expect(calls[1].request.runs).toEqual([
      { start: 0, count: 2, basis: 'b-1' },
      {
        start: 2,
        count: 1,
        basis: 'b-2',
        // A batch of the same request by its place in it; a batch of an
        // earlier request by that request's id.
        after: [
          { operationId: 'op-1', start: 0, count: 1 },
          { start: 0, count: 2 },
        ],
      },
    ]);
  });

  describe('a batch made on top of a batch of an earlier request', () => {
    function queueWithOutcomes() {
      const calls: Call[] = [];
      const outcomes = new Map<string, 'applied' | 'refused'>();
      let nextId = 0;
      const queue = createSendQueue({
        clientId: 'page-a',
        createId: () => `op-${++nextId}`,
        runOutcome: (ref) => outcomes.get(`${ref.entryId}:${ref.start}`),
        send: (_canvasId, request, options) =>
          new Promise((resolve, reject) => {
            calls.push({
              request: structuredClone(request),
              keepalive: options?.keepalive === true,
              resolve,
              reject,
            });
          }),
      });
      queue.enqueue('space', [move(1), move(2)], { run: { basis: 'b-1' } });
      const onTop = {
        run: {
          basis: 'b-1',
          after: [{ entryId: 'op-1', start: 0, count: 2 }],
        },
      };
      queue.enqueue('space', [move(3)], onTop);
      queue.enqueue('space', [move(4)], onTop);
      return { queue, calls, outcomes };
    }

    it('no longer names it once it is known to have taken effect', async () => {
      const { calls, outcomes } = queueWithOutcomes();
      outcomes.set('op-1:0', 'applied');
      calls[0].resolve(response(calls[0].request, 1));
      await vi.advanceTimersByTimeAsync(0);
      expect(calls[1].request.runs).toEqual([
        { start: 0, count: 1, basis: 'b-1' },
        { start: 1, count: 1, basis: 'b-1' },
      ]);
    });

    it('names it when it was refused', async () => {
      const { calls, outcomes } = queueWithOutcomes();
      outcomes.set('op-1:0', 'refused');
      calls[0].resolve(response(calls[0].request, 1));
      await vi.advanceTimersByTimeAsync(0);
      const named = [{ operationId: 'op-1', start: 0, count: 2 }];
      expect(calls[1].request.runs).toEqual([
        { start: 0, count: 1, basis: 'b-1', after: named },
        { start: 1, count: 1, basis: 'b-1', after: named },
      ]);
    });

    it('names it in a page-close flush, and repeats exactly that request afterwards', async () => {
      const { queue, calls, outcomes } = queueWithOutcomes();
      // Sent before the first answer is known.
      queue.flushKeepalive();
      const flushed = calls.filter((call) => call.keepalive);
      expect(flushed).toHaveLength(2);
      expect(flushed[1].request.runs?.[0]?.after).toEqual([
        { operationId: 'op-1', start: 0, count: 2 },
      ]);
      // The page stayed open. A request id answers only the request it was
      // first used for, so nothing is folded in and nothing is rewritten.
      queue.enqueue('space', [move(5)], { run: { basis: 'b-2' } });
      outcomes.set('op-1:0', 'applied');
      calls[0].resolve(response(calls[0].request, 1));
      await vi.advanceTimersByTimeAsync(0);
      const repeated = calls[calls.length - 1];
      expect(repeated.keepalive).toBe(false);
      expect(repeated.request).toEqual(flushed[1].request);
    });
  });

  it('waits for a gate and fails the entry without sending when it rejects', async () => {
    const { queue, calls, settled, flush } = harness();
    let open!: () => void;
    let refuse!: (error: Error) => void;
    queue.enqueue('space', [move(1)], {
      gate: new Promise<void>((resolve) => {
        open = resolve;
      }),
    });
    queue.enqueue('space', [move(2)], {
      gate: new Promise<void>((_resolve, reject) => {
        refuse = reject;
      }),
    });
    queue.enqueue('space', [move(3)]);
    await flush();
    expect(calls).toHaveLength(0);

    open();
    await flush();
    expect(calls).toHaveLength(1);
    calls[0].resolve(response(calls[0].request, 1));
    refuse(new Error('fork failed'));
    await flush();

    expect(settled[1]).toMatchObject({
      id: 'op-2',
      outcome: { kind: 'failed', sent: false },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].request.commands).toEqual([move(3)]);
  });

  it('discards every unanswered entry', async () => {
    const { queue, calls, settled, flush } = harness();
    const first = queue.enqueue('space', [move(1)]);
    queue.enqueue('space', [move(2)]);
    queue.discard('space');
    expect(settled.map(({ outcome }) => outcome.kind)).toEqual([
      'discarded',
      'discarded',
    ]);
    await expect(first.entry.settled).resolves.toEqual({ kind: 'discarded' });
    expect(queue.hasPending('space')).toBe(false);
    expect(queue.status('space').phase).toBe('idle');

    // The late answer of the dropped request is ignored.
    calls[0].resolve(response(calls[0].request, 1));
    await flush();
    expect(settled).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });

  it('keeps Spaces in separate lanes', async () => {
    const { queue, calls } = harness();
    queue.enqueue('space', [move(1)]);
    queue.enqueue('other', [move(2)]);
    expect(calls).toHaveLength(2);
    expect(queue.hasPending('other')).toBe(true);
  });

  it('page close: repeats the request on the wire and sends the rest with keepalive', () => {
    const { queue, calls } = harness();
    queue.enqueue('space', [move(1)]);
    queue.enqueue('space', [move(2)]);
    queue.flushKeepalive();
    const flushed = calls.filter((call) => call.keepalive);
    expect(flushed.map((call) => call.request.operationId)).toEqual([
      'op-1',
      'op-2',
    ]);
    // Same id as the request that may be cut off: it cannot run twice.
    expect(flushed[0].request).toEqual(calls[0].request);
  });

  it('reports status changes to subscribers', async () => {
    const { queue, calls, flush } = harness();
    const phases: string[] = [];
    const unsubscribe = queue.subscribe((status) => phases.push(status.phase));
    queue.enqueue('space', [move(1)]);
    calls[0].reject(new TypeError('offline'));
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    calls[1].resolve(response(calls[1].request, 1));
    await flush();
    unsubscribe();
    expect(phases).toContain('retrying');
    expect(phases.at(-1)).toBe('idle');
  });
});
