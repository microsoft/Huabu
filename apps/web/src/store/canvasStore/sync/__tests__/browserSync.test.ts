// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeBasis } from '@huabu/shared';

import {
  createBrowserSync,
  ECHO_TIMEOUT_MS,
  RELOAD_RETRY,
  type BrowserSyncDeps,
  type ReloadOutcome,
} from '../browserSync';

import type {
  CanvasCommand,
  PostCanvasExecuteRequest,
  PostCanvasExecuteResponse,
} from '@huabu/shared';

const SPACE = 'space';
const X = 'node-x';

const move = (x: number): CanvasCommand =>
  ({
    type: 'SET_NODE_GEOMETRY',
    items: [{ nodeId: X, position: { x, y: 0 } }],
  }) as CanvasCommand;

const nodeAt = (x: number) => ({
  nodes: [{ id: X, type: 'note', position: { x, y: 0 }, data: {} }],
  edges: [],
});

function responseTo(
  request: PostCanvasExecuteRequest,
  fromVersion: number,
): PostCanvasExecuteResponse {
  return {
    canvasId: SPACE,
    fromVersion,
    toVersion: fromVersion + 1,
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

interface Sent {
  request: PostCanvasExecuteRequest;
  resolve: (response: PostCanvasExecuteResponse) => void;
}

function harness(reload: BrowserSyncDeps['reload'], lineage?: string) {
  const sent: Sent[] = [];
  const page = { canvasId: SPACE, version: 1, ...(lineage ? { lineage } : {}) };
  const applyOwnResponse = vi.fn();
  const onRejected = vi.fn();
  const sync = createBrowserSync({
    send: (_canvasId, request) =>
      new Promise((resolve) => {
        sent.push({ request, resolve });
      }),
    clientId: 'page-a',
    getState: () => page,
    applyOwnResponse,
    applyWithheld: vi.fn(),
    onRejected,
    reload,
  });
  return { sync, sent, page, applyOwnResponse, onRejected };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('a wanted reload', () => {
  it('is asked for again, with a growing wait, while its load fails; a load that succeeds ends it', async () => {
    const outcomes: ReloadOutcome[] = ['failed', 'failed', 'loaded'];
    const reload = vi.fn(async () => outcomes.shift() ?? 'loaded');
    const { sync } = harness(reload);

    sync.deferReload(SPACE);
    expect(reload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RELOAD_RETRY.initialMs - 1);
    expect(reload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reload).toHaveBeenCalledTimes(2);
    // The second wait is twice the first.
    await vi.advanceTimersByTimeAsync(RELOAD_RETRY.initialMs * 2 - 1);
    expect(reload).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(reload).toHaveBeenCalledTimes(3);
    // It loaded: nothing asks again.
    await vi.advanceTimersByTimeAsync(RELOAD_RETRY.maxMs * 4);
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it('never waits longer than the cap between attempts', async () => {
    const reload = vi.fn(async (): Promise<ReloadOutcome> => 'failed');
    const { sync } = harness(reload);
    sync.deferReload(SPACE);
    // Long enough for the wait to have reached the cap.
    await vi.advanceTimersByTimeAsync(RELOAD_RETRY.maxMs * 6);
    const before = reload.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RELOAD_RETRY.maxMs);
    expect(reload.mock.calls.length).toBe(before + 1);
  });

  it('treats a load that throws as failed', async () => {
    const reload = vi
      .fn<BrowserSyncDeps['reload']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue('loaded');
    const { sync } = harness(reload);
    sync.deferReload(SPACE);
    await vi.advanceTimersByTimeAsync(RELOAD_RETRY.initialMs);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('runs one at a time: a reload wanted while one is loading runs after it', async () => {
    let finish: (outcome: ReloadOutcome) => void = () => undefined;
    const reload = vi.fn(
      () =>
        new Promise<ReloadOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    const { sync } = harness(reload);
    sync.deferReload(SPACE);
    sync.deferReload(SPACE);
    expect(reload).toHaveBeenCalledTimes(1);
    finish('loaded');
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('is asked for again at once when the load was overtaken, and left to its owner when held', async () => {
    const outcomes: ReloadOutcome[] = ['again', 'held'];
    const reload = vi.fn(async () => outcomes.shift() ?? 'loaded');
    const { sync } = harness(reload);
    sync.deferReload(SPACE);
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).toHaveBeenCalledTimes(2);
    // Held: whoever holds it asks again.
    await vi.advanceTimersByTimeAsync(RELOAD_RETRY.maxMs * 4);
    expect(reload).toHaveBeenCalledTimes(2);
    sync.deferReload(SPACE);
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it('a load made by someone else ends the retries', async () => {
    const reload = vi.fn(async (): Promise<ReloadOutcome> => 'failed');
    const { sync } = harness(reload);
    sync.deferReload(SPACE);
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).toHaveBeenCalledTimes(1);
    sync.adoptedServerState(SPACE);
    await vi.advanceTimersByTimeAsync(RELOAD_RETRY.maxMs * 4);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('the update for a confirmed batch that does not arrive', () => {
  /** A batch is answered with a version the page cannot apply yet. */
  async function answeredAhead(reload: BrowserSyncDeps['reload']) {
    const page = harness(reload);
    page.sync.submit({
      canvasId: SPACE,
      commands: [move(100)],
      prev: nodeAt(0),
      next: nodeAt(100),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(page.sent).toHaveLength(1);
    // Another writer committed version 2 first; the page is still at 1.
    page.sent[0].resolve(responseTo(page.sent[0].request, 2));
    await vi.advanceTimersByTimeAsync(0);
    expect(page.applyOwnResponse).not.toHaveBeenCalled();
    return page;
  }

  it('reloads the Space when the wait runs out', async () => {
    const reload = vi.fn(async (): Promise<ReloadOutcome> => 'loaded');
    await answeredAhead(reload);
    await vi.advanceTimersByTimeAsync(ECHO_TIMEOUT_MS - 1);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reload).toHaveBeenCalledExactlyOnceWith(SPACE);
  });

  it('does not reload when the stream delivers the update in time', async () => {
    const reload = vi.fn(async (): Promise<ReloadOutcome> => 'loaded');
    const { sync, sent, page } = await answeredAhead(reload);
    await vi.advanceTimersByTimeAsync(ECHO_TIMEOUT_MS - 1);
    // The other writer's update, then this page's own, arrive on the stream.
    page.version = 2;
    const own = sync.prepareRemote({
      deltas: [],
      localNodes: nodeAt(100).nodes,
      localEdges: [],
      operationId: sent[0].request.operationId as string,
      source: 'ui',
    });
    expect(own.own).toBe(true);
    own.finish();
    page.version = 3;
    await vi.advanceTimersByTimeAsync(ECHO_TIMEOUT_MS * 2);
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps reloading until a load succeeds', async () => {
    const outcomes: ReloadOutcome[] = ['failed', 'loaded'];
    const reload = vi.fn(async () => outcomes.shift() ?? 'loaded');
    await answeredAhead(reload);
    await vi.advanceTimersByTimeAsync(ECHO_TIMEOUT_MS);
    expect(reload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RELOAD_RETRY.initialMs);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

describe('a replayed answer', () => {
  /** The first answer was lost; the repeat is answered from the stored outcome. */
  async function answeredByReplay(reload: BrowserSyncDeps['reload']) {
    const page = harness(reload);
    page.sync.submit({
      canvasId: SPACE,
      commands: [move(100)],
      prev: nodeAt(0),
      next: nodeAt(100),
    });
    await vi.advanceTimersByTimeAsync(0);
    // The version the page has applied is the one the request started from:
    // with deltas this answer would be applied as the update.
    const { deltas: _deltas, ...stored } = responseTo(page.sent[0].request, 1);
    page.sent[0].resolve({ ...stored, replayed: true });
    await vi.advanceTimersByTimeAsync(0);
    return page;
  }

  it('is applied as the update when it is the first answer and carries the deltas', async () => {
    const reload = vi.fn(async (): Promise<ReloadOutcome> => 'loaded');
    const { sync, sent, applyOwnResponse } = harness(reload);
    sync.submit({
      canvasId: SPACE,
      commands: [move(100)],
      prev: nodeAt(0),
      next: nodeAt(100),
    });
    await vi.advanceTimersByTimeAsync(0);
    const answer = responseTo(sent[0].request, 1);
    sent[0].resolve(answer);
    await vi.advanceTimersByTimeAsync(0);
    expect(applyOwnResponse).toHaveBeenCalledExactlyOnceWith(
      answer,
      sent[0].request.operationId,
    );
  });

  it('carries no deltas and is not applied as the update; the update on the stream settles the batch', async () => {
    const reload = vi.fn(async (): Promise<ReloadOutcome> => 'loaded');
    const { sync, sent, page, applyOwnResponse, onRejected } =
      await answeredByReplay(reload);
    expect(applyOwnResponse).not.toHaveBeenCalled();
    expect(onRejected).not.toHaveBeenCalled();
    expect(sync.queue.hasPending(SPACE)).toBe(false);

    const own = sync.prepareRemote({
      deltas: [],
      localNodes: nodeAt(100).nodes,
      localEdges: [],
      operationId: sent[0].request.operationId as string,
      source: 'ui',
    });
    expect(own.own).toBe(true);
    own.finish();
    page.version = 2;
    await vi.advanceTimersByTimeAsync(ECHO_TIMEOUT_MS * 2);
    expect(reload).not.toHaveBeenCalled();
    expect(applyOwnResponse).not.toHaveBeenCalled();
  });

  it('reloads the Space when the update does not arrive either', async () => {
    const reload = vi.fn(async (): Promise<ReloadOutcome> => 'loaded');
    const { applyOwnResponse } = await answeredByReplay(reload);
    await vi.advanceTimersByTimeAsync(ECHO_TIMEOUT_MS - 1);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reload).toHaveBeenCalledExactlyOnceWith(SPACE);
    expect(applyOwnResponse).not.toHaveBeenCalled();
  });
});

describe('a refused edit', () => {
  const LINEAGE = '00000000-0000-4000-8000-000000000001';
  const Y = 'node-y';
  const recolour = {
    type: 'MERGE_NODE_DATA',
    patches: [{ nodeId: Y, patch: { style: { accent: 'red' } } }],
  } as CanvasCommand;
  const both = (x: number, accent: string) => ({
    nodes: [
      ...nodeAt(x).nodes,
      {
        id: Y,
        type: 'note',
        position: { x: 0, y: 300 },
        data: { style: { accent } },
      },
    ],
    edges: [],
  });
  const REFUSED = {
    applied: false,
    reason: 'stale-parent',
    results: [{ applied: false, reason: 'stale-parent' }],
  };
  const APPLIED = { applied: true, results: [{ applied: true }] };

  it('is reported once per request; each batch is told its own outcome by its position, and an edit made on top of it names it', async () => {
    const reload = vi.fn(async (): Promise<ReloadOutcome> => 'loaded');
    const { sync, sent, applyOwnResponse, onRejected } = harness(
      reload,
      LINEAGE,
    );
    const basis = encodeBasis(LINEAGE, 1);
    const told: unknown[] = [];
    const tell =
      (name: string) =>
      (
        outcome: Parameters<
          NonNullable<Parameters<typeof sync.submit>[0]['onSettled']>
        >[0],
        edit: number,
      ) =>
        told.push([
          name,
          edit,
          outcome.kind === 'response'
            ? outcome.response.edits[edit]
            : outcome.kind,
        ]);

    const first = sync.submit({
      canvasId: SPACE,
      commands: [move(100)],
      prev: both(0, 'white'),
      next: both(100, 'white'),
      onSettled: tell('first'),
    });
    // Made while the first request is on the wire: a move of the same node,
    // and a change to another node.
    const onTop = sync.submit({
      canvasId: SPACE,
      commands: [move(200)],
      prev: both(100, 'white'),
      next: both(200, 'white'),
      onSettled: tell('on top'),
    });
    const unrelated = sync.submit({
      canvasId: SPACE,
      commands: [recolour],
      prev: both(200, 'white'),
      next: both(200, 'red'),
      onSettled: tell('unrelated'),
    });
    expect(first.edit).toBe(0);
    expect(onTop.entry).not.toBe(first.entry);
    expect(unrelated.entry).toBe(onTop.entry);
    expect([onTop.edit, unrelated.edit]).toEqual([0, 1]);
    expect(sent[0].request.edits).toEqual([{ basis, commands: [move(100)] }]);

    // The server refuses the first move and writes nothing.
    sent[0].resolve({
      ...responseTo(sent[0].request, 1),
      toVersion: 1,
      edits: [REFUSED],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(onRejected.mock.calls[0][0]).toMatchObject({
      canvasId: SPACE,
      entry: { id: first.entry.id },
      outcome: { kind: 'response' },
    });
    expect(applyOwnResponse).not.toHaveBeenCalled();
    // The reload waits for what is still to be sent.
    expect(reload).not.toHaveBeenCalled();

    // The second request: the move names the refused edit it was made on
    // top of, by request id and position; the recolour names nothing.
    expect(sent[1].request.edits).toEqual([
      {
        basis,
        after: [{ operationId: first.entry.id, edit: 0 }],
        commands: [move(200)],
      },
      { basis, commands: [recolour] },
    ]);
    const second = {
      ...responseTo(sent[1].request, 1),
      edits: [REFUSED, APPLIED],
    };
    sent[1].resolve(second);
    await vi.advanceTimersByTimeAsync(0);
    // What the request did change is applied; its refused edit is reported.
    expect(applyOwnResponse).toHaveBeenCalledExactlyOnceWith(
      second,
      onTop.entry.id,
    );
    expect(onRejected).toHaveBeenCalledTimes(2);
    expect(onRejected.mock.calls[1][0]).toMatchObject({
      entry: { id: onTop.entry.id },
    });
    expect(told).toEqual([
      ['first', 0, REFUSED],
      ['on top', 0, REFUSED],
      ['unrelated', 1, APPLIED],
    ]);
    // One reload for both, once nothing is left to send.
    expect(reload).toHaveBeenCalledExactlyOnceWith(SPACE);
  });

  it('is no longer named by an edit made on top of an edit that took effect', async () => {
    const reload = vi.fn(async (): Promise<ReloadOutcome> => 'loaded');
    const { sync, sent, onRejected } = harness(reload, LINEAGE);
    const basis = encodeBasis(LINEAGE, 1);
    sync.submit({
      canvasId: SPACE,
      commands: [move(100)],
      prev: nodeAt(0),
      next: nodeAt(100),
    });
    sync.submit({
      canvasId: SPACE,
      commands: [move(200)],
      prev: nodeAt(100),
      next: nodeAt(200),
    });
    sync.submit({
      canvasId: SPACE,
      commands: [move(300)],
      prev: nodeAt(200),
      next: nodeAt(300),
    });
    sent[0].resolve(responseTo(sent[0].request, 1));
    await vi.advanceTimersByTimeAsync(0);
    // The first request took effect, so only the edit of the same request
    // is named, by its position alone.
    expect(sent[1].request.edits).toEqual([
      { basis, commands: [move(200)] },
      { basis, after: [{ edit: 0 }], commands: [move(300)] },
    ]);
    expect(onRejected).not.toHaveBeenCalled();
  });
});
