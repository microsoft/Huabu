// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createBrowserSync,
  ECHO_TIMEOUT_MS,
  type BrowserSyncDeps,
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
    results: request.commands.map((command) => ({ command, applied: true })),
    commands: request.commands,
    pendingEffects: {
      mutatedNodes: [],
      deletedNodeIds: [],
      contentEditedNodeIds: [],
      deferredFitFrameIds: [],
    },
    operationId: request.operationId,
  } as PostCanvasExecuteResponse;
}

interface Sent {
  request: PostCanvasExecuteRequest;
  resolve: (response: PostCanvasExecuteResponse) => void;
}

function harness(reload: BrowserSyncDeps['reload']) {
  const sent: Sent[] = [];
  const page = { canvasId: SPACE, version: 1 };
  const applyOwnResponse = vi.fn();
  const sync = createBrowserSync({
    send: (_canvasId, request) =>
      new Promise((resolve) => {
        sent.push({ request, resolve });
      }),
    clientId: 'page-a',
    getState: () => page,
    applyOwnResponse,
    applyWithheld: vi.fn(),
    onRejected: vi.fn(),
    reload,
  });
  return { sync, sent, page, applyOwnResponse };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
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
    const reload = vi.fn();
    await answeredAhead(reload);
    await vi.advanceTimersByTimeAsync(ECHO_TIMEOUT_MS - 1);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reload).toHaveBeenCalledExactlyOnceWith(SPACE);
  });

  it('does not reload when the stream delivers the update in time', async () => {
    const reload = vi.fn();
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
});
