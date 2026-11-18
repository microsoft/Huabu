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
    edits: request.edits.map((edit) => ({
      applied: true,
      results: edit.commands.map(() => ({ applied: true })),
    })),
    pendingEffects: {
      mutatedNodeIds: [],
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
  it('mints request ids where `crypto.randomUUID` does not exist (a page served over plain HTTP)', () => {
    const original = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
    Object.defineProperty(crypto, 'randomUUID', {
      value: undefined,
      configurable: true,
    });
    try {
      const requests: PostCanvasExecuteRequest[] = [];
      const queue = createSendQueue({
        clientId: 'page-a',
        send: (_canvasId, request) => {
          requests.push(request);
          return new Promise(() => {});
        },
      });
      queue.enqueue('space', [move(1)]);
      expect(requests).toHaveLength(1);
      expect(requests[0].operationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      if (original) Object.defineProperty(crypto, 'randomUUID', original);
      else Reflect.deleteProperty(crypto, 'randomUUID');
    }
  });

  it('sends one request at a time, in order, each with its own request id', async () => {
    const { queue, calls, settled, flush } = harness();
    queue.enqueue('space', [move(1)]);
    queue.enqueue('space', [move(2)]);
    expect(calls).toHaveLength(1);
    // The whole request: its id, the page, its edits. A batch enqueued
    // without a read version is an edit without one.
    expect(calls[0].request).toEqual({
      operationId: 'op-1',
      originator: { tabId: 'page-a' },
      edits: [{ commands: [move(1)] }],
    });
    expect(calls[0].request).not.toHaveProperty('basis');
    expect(calls[0].request.originator).not.toHaveProperty('source');
    expect(calls[0].request.edits[0]).not.toHaveProperty('basis');
    expect(calls[0].request.edits[0]).not.toHaveProperty('after');
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

    // The server answers the repeat from its stored result, which carries
    // no deltas.
    const { deltas: _deltas, ...stored } = response(calls[1].request, 1);
    calls[1].resolve({ ...stored, replayed: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveLength(1);
    expect(settled[0].outcome).toEqual({
      kind: 'response',
      response: { ...stored, replayed: true },
    });
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
    expect(calls[1].request.edits.map((edit) => edit.commands)).toEqual([
      [move(2)],
    ]);
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

  it('folds edits made while a request is on the wire into one request, one edit per batch', async () => {
    const { queue, calls, flush } = harness();
    const first = queue.enqueue('space', [move(1)]);
    const second = queue.enqueue('space', [move(2)]);
    const third = queue.enqueue('space', [move(3)]);
    expect(first.entry).not.toBe(second.entry);
    expect(third.entry).toBe(second.entry);
    expect([first.edit, second.edit, third.edit]).toEqual([0, 0, 1]);

    // The merged batch is capped; a longer run starts another entry.
    queue.enqueue('space', [move(4)]);
    const overflow = queue.enqueue('space', [move(5)]);
    expect(overflow.entry).not.toBe(second.entry);
    expect(overflow.edit).toBe(0);

    calls[0].resolve(response(calls[0].request, 1));
    await flush();
    expect(calls[1].request.edits.map((edit) => edit.commands)).toEqual([
      [move(2)],
      [move(3)],
      [move(4)],
    ]);
  });

  it('sends each folded batch as an edit with the read version it was made on', async () => {
    const { queue, calls, flush } = harness();
    queue.enqueue('space', [move(1)]);
    // No read version stated: the edit carries none.
    expect(calls[0].request).not.toHaveProperty('runs');
    expect(calls[0].request.edits).toEqual([{ commands: [move(1)] }]);
    queue.enqueue('space', [move(2), move(3)], { basis: 'b-1' });
    queue.enqueue('space', [move(4)], {
      basis: 'b-2',
      after: [
        { entryId: 'op-1', edit: 0 },
        { entryId: 'op-2', edit: 0 },
      ],
    });
    calls[0].resolve(response(calls[0].request, 1));
    await flush();
    // Each folded batch keeps its own commands and its own read version.
    expect(calls[1].request.edits).toEqual([
      { basis: 'b-1', commands: [move(2), move(3)] },
      {
        basis: 'b-2',
        // A batch of the same request by its place in it; a batch of an
        // earlier request by that request's id.
        after: [{ operationId: 'op-1', edit: 0 }, { edit: 0 }],
        commands: [move(4)],
      },
    ]);
  });

  it('holds edits: what an entry holds is what its request says', async () => {
    const { queue, calls, flush } = harness();
    queue.enqueue('space', [move(1)]);
    const second = queue.enqueue('space', [move(2), move(3)], { basis: 'b-1' });
    const third = queue.enqueue('space', [move(4)], {
      basis: 'b-2',
      after: [{ entryId: second.entry.id, edit: second.edit }],
    });
    expect(third.entry).toBe(second.entry);
    expect([second.edit, third.edit]).toEqual([0, 1]);
    // No command list beside the edits, and no index into one.
    expect(second.entry).not.toHaveProperty('commands');
    expect(second.entry).not.toHaveProperty('runs');
    expect(second.entry.edits).toEqual([
      { commands: [move(2), move(3)], basis: 'b-1', after: [] },
      {
        commands: [move(4)],
        basis: 'b-2',
        after: [{ entryId: 'op-2', edit: 0 }],
      },
    ]);

    calls[0].resolve(response(calls[0].request, 1));
    await flush();
    const { request } = calls[1];
    expect(Object.keys(request).sort()).toEqual([
      'edits',
      'operationId',
      'originator',
    ]);
    expect(request.edits).toHaveLength(second.entry.edits.length);
    second.entry.edits.forEach((held, position) => {
      expect(request.edits[position]?.commands).toEqual(held.commands);
      expect(request.edits[position]?.basis).toBe(held.basis);
    });
    expect(request.edits.map((edit) => edit.after)).toEqual([
      undefined,
      [{ edit: 0 }],
    ]);
  });

  it('a batch without commands is no edit, and an entry without edits is answered without a request', async () => {
    const { queue, calls, settled, flush } = harness();
    // Alone in the lane: nothing to send.
    const empty = queue.enqueue('space', []);
    expect(empty.edit).toBe(-1);
    expect(empty.entry.edits).toEqual([]);
    await flush();
    expect(calls).toHaveLength(0);
    expect(settled).toHaveLength(1);
    expect(settled[0].outcome).toMatchObject({
      kind: 'response',
      response: { fromVersion: 0, toVersion: 0, edits: [], deltas: [] },
    });
    expect(queue.hasPending('space')).toBe(false);

    // Folded into an entry that waits: it adds no edit there either.
    queue.enqueue('space', [move(1)]);
    const waiting = queue.enqueue('space', [move(2)]);
    const folded = queue.enqueue('space', []);
    expect(folded.entry).toBe(waiting.entry);
    expect(folded.edit).toBe(-1);
    expect(waiting.entry.edits).toHaveLength(1);
    // The next batch takes the next position.
    expect(queue.enqueue('space', [move(3)]).edit).toBe(1);
  });

  it('freezes an entry when it is first sent: a later batch starts a new entry and the repeat is the same request', async () => {
    const { queue, calls, flush } = harness();
    const first = queue.enqueue('space', [move(1)], { basis: 'b-1' });
    expect(calls).toHaveLength(1);
    const sentAs = JSON.stringify(calls[0].request);
    calls[0].reject(new TypeError('Failed to fetch'));
    await flush();
    expect(queue.status('space').phase).toBe('retrying');

    // Made while the first request waits to be repeated, on top of it.
    const later = queue.enqueue('space', [move(2)], {
      basis: 'b-1',
      after: [{ entryId: first.entry.id, edit: first.edit }],
    });
    expect(later.entry).not.toBe(first.entry);
    expect(later.entry.id).toBe('op-2');
    expect(later.edit).toBe(0);
    expect(first.entry.edits).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1].request)).toBe(sentAs);

    // `{ operationId, edit }` still names the edit it named when it was made.
    calls[1].resolve(response(calls[1].request, 1));
    await flush();
    expect(calls[2].request).toEqual({
      operationId: 'op-2',
      originator: { tabId: 'page-a' },
      edits: [
        {
          basis: 'b-1',
          after: [{ operationId: 'op-1', edit: 0 }],
          commands: [move(2)],
        },
      ],
    });
  });

  it('names an edit of the same request by its position alone and one of an earlier request by request id and position', async () => {
    const { queue, calls, flush } = harness();
    queue.enqueue('space', [move(1)]);
    queue.enqueue('space', [move(2)], { basis: 'b-1' });
    const earlier = queue.enqueue('space', [move(3)], { basis: 'b-1' });
    expect(earlier).toMatchObject({ entry: { id: 'op-2' }, edit: 1 });
    // The page-close flush sends the second entry, which fixes it.
    queue.flushKeepalive();
    const sameRequest = queue.enqueue('space', [move(4)], {
      basis: 'b-1',
      after: [{ entryId: 'op-2', edit: 1 }],
    });
    expect(sameRequest).toMatchObject({ entry: { id: 'op-3' }, edit: 0 });
    queue.enqueue('space', [move(5)], {
      basis: 'b-1',
      after: [
        { entryId: 'op-2', edit: 1 },
        { entryId: 'op-3', edit: 0 },
      ],
    });
    for (const index of [0, 1]) {
      const call = calls.filter((sent) => !sent.keepalive)[index];
      call.resolve(response(call.request, index + 1));
      await flush();
    }
    const third = calls.filter((sent) => !sent.keepalive)[2];
    expect(third.request.operationId).toBe('op-3');
    expect(third.request.edits.map((edit) => edit.after)).toEqual([
      [{ operationId: 'op-2', edit: 1 }],
      [{ operationId: 'op-2', edit: 1 }, { edit: 0 }],
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
        editOutcome: (ref) => outcomes.get(`${ref.entryId}:${ref.edit}`),
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
      queue.enqueue('space', [move(1), move(2)], { basis: 'b-1' });
      const onTop = {
        basis: 'b-1',
        after: [{ entryId: 'op-1', edit: 0 }],
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
      expect(calls[1].request.edits).toEqual([
        { basis: 'b-1', commands: [move(3)] },
        { basis: 'b-1', commands: [move(4)] },
      ]);
    });

    it('names it when it was refused', async () => {
      const { calls, outcomes } = queueWithOutcomes();
      outcomes.set('op-1:0', 'refused');
      calls[0].resolve(response(calls[0].request, 1));
      await vi.advanceTimersByTimeAsync(0);
      const named = [{ operationId: 'op-1', edit: 0 }];
      expect(calls[1].request.edits).toEqual([
        { basis: 'b-1', after: named, commands: [move(3)] },
        { basis: 'b-1', after: named, commands: [move(4)] },
      ]);
    });

    it('names it in a page-close flush, and repeats exactly that request afterwards', async () => {
      const { queue, calls, outcomes } = queueWithOutcomes();
      // Sent before the first answer is known.
      queue.flushKeepalive();
      const flushed = calls.filter((call) => call.keepalive);
      expect(flushed).toHaveLength(2);
      expect(flushed[1].request.edits[0]?.after).toEqual([
        { operationId: 'op-1', edit: 0 },
      ]);
      // The page stayed open. A request id answers only the request it was
      // first used for, so nothing is folded in and nothing is rewritten.
      const later = queue.enqueue('space', [move(5)], { basis: 'b-2' });
      expect(later).toMatchObject({ entry: { id: 'op-3' }, edit: 0 });
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
    expect(calls[1].request.edits.map((edit) => edit.commands)).toEqual([
      [move(3)],
    ]);
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
