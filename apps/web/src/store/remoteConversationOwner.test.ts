// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/_client';

import {
  conversationOwnerKey,
  refreshConversationOwner,
  subscribeConversationOwner,
  useRemoteConversationOwnerStore,
} from './remoteConversationOwner';

import type {
  AgentConversationOwnerEvent,
  AgentConversationOwnerResponse,
} from '@huabu/shared';

const mocks = vi.hoisted(() => ({
  getOwner: vi.fn(),
  stream: vi.fn(),
  invalidateHistory: vi.fn(),
  clearHistoryError: vi.fn(),
  claimed: false,
}));
vi.mock('@/api/agent', () => ({
  getAgentConversationOwner: mocks.getOwner,
  streamAgentConversationOwner: mocks.stream,
}));
vi.mock('./conversationTitleStore', () => ({
  invalidateConversationTitle: vi.fn(),
}));
vi.mock('./chatStore', () => ({
  useChatStore: {
    getState: () => ({
      setHistoryLoaded: mocks.invalidateHistory,
      setHistoryError: mocks.clearHistoryError,
    }),
  },
}));
vi.mock('@/hooks/agentStreamCoordinator', () => ({
  hasAgentStreamClaim: () => mocks.claimed,
}));

type Snapshot = Extract<AgentConversationOwnerEvent, { type: 'snapshot' }>;
const owner: AgentConversationOwnerResponse = {
  canvasId: 'child',
  nodeId: 'node-agent',
  threadId: 'thread',
  spaceTitle: 'Child',
  source: {
    status: 'done',
    invocationToken: 'first',
    hasAuthoredContent: true,
    agentBinding: { kind: 'internal' },
  },
};
const key = conversationOwnerKey('child', 'node-agent', 'thread');
const cleanups: Array<() => void> = [];
let receive: (event: Snapshot) => void;
let fail: (error: unknown) => void;
let signal: AbortSignal;
const snapshot = (
  revision = 1,
  value = owner,
  streamId = 'connection',
): Snapshot => ({
  type: 'snapshot',
  data: { revision, streamId, value: { state: 'ready', owner: value } },
});
const observe = (listener?: () => void) => {
  const stop = subscribeConversationOwner(
    'child',
    'node-agent',
    'thread',
    listener,
  );
  cleanups.push(stop);
  return stop;
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.claimed = false;
  mocks.getOwner.mockResolvedValue(owner);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  useRemoteConversationOwnerStore.setState({ entries: {} });
  mocks.stream.mockImplementation((_canvas, _thread, callback, abortSignal) => {
    receive = callback;
    signal = abortSignal;
    return new Promise<void>((resolve, reject) => {
      fail = reject;
      abortSignal.addEventListener('abort', () => resolve(), { once: true });
    });
  });
});
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('shares one address stream, applies full snapshots without GETs, and releases the final viewer', async () => {
  const first = observe();
  const listener = vi.fn();
  const second = observe(listener);
  receive(snapshot());
  receive(
    snapshot(2, { ...owner, source: { ...owner.source, status: 'running' } }),
  );
  expect(
    useRemoteConversationOwnerStore.getState().entries[key]?.owner?.source
      .status,
  ).toBe('running');
  expect(listener).toHaveBeenCalledTimes(2);
  expect(mocks.stream).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.getOwner).not.toHaveBeenCalled();
  first();
  expect(signal.aborted).toBe(false);
  second();
  expect(signal.aborted).toBe(true);
});

it('ignores duplicate/older snapshots and foreign epochs, and calibrates a revision gap directly', () => {
  observe();
  receive(snapshot(2));
  mocks.invalidateHistory.mockClear();
  receive(snapshot(1, { ...owner, spaceTitle: 'Stale' }));
  receive(snapshot(2, { ...owner, spaceTitle: 'Duplicate' }));
  receive(snapshot(99, { ...owner, spaceTitle: 'Old connection' }, 'other'));
  expect(
    useRemoteConversationOwnerStore.getState().entries[key]?.owner?.spaceTitle,
  ).toBe('Child');
  expect(mocks.invalidateHistory).not.toHaveBeenCalled();
  receive(snapshot(4, { ...owner, spaceTitle: 'Latest' }));
  expect(mocks.invalidateHistory).toHaveBeenCalledWith('thread', false);
  expect(mocks.getOwner).not.toHaveBeenCalled();
});

it('recalibrates after reconnect even if the process epoch and revision reset', () => {
  observe();
  receive(snapshot(10));
  const oldReceive = receive;
  const oldSignal = signal;
  window.dispatchEvent(new Event('focus'));
  expect(oldSignal.aborted).toBe(true);
  receive(snapshot(1, { ...owner, spaceTitle: 'Restarted' }, 'new-process'));
  oldReceive(snapshot(11, { ...owner, spaceTitle: 'Late old stream' }));
  expect(
    useRemoteConversationOwnerStore.getState().entries[key]?.owner?.spaceTitle,
  ).toBe('Restarted');
  expect(mocks.invalidateHistory).toHaveBeenCalledTimes(2);
});

it('does not invalidate history owned by an active local send', () => {
  mocks.claimed = true;
  observe();
  receive(snapshot());
  expect(mocks.invalidateHistory).not.toHaveBeenCalled();
});

it('publishes missing ownership, retains display identity, and recovers on a later snapshot', () => {
  observe();
  receive(snapshot());
  receive({
    type: 'snapshot',
    data: {
      revision: 2,
      streamId: 'connection',
      value: {
        state: 'unavailable',
        status: 404,
        error: { message: 'Missing', code: 'conversation_owner_missing' },
      },
    },
  });
  expect(useRemoteConversationOwnerStore.getState().entries[key]).toMatchObject(
    {
      lastKnownOwner: owner,
      errorCode: 'conversation_owner_missing',
    },
  );
  expect(
    useRemoteConversationOwnerStore.getState().entries[key]?.owner,
  ).toBeUndefined();
  receive(snapshot(3));
  expect(
    useRemoteConversationOwnerStore.getState().entries[key]?.error,
  ).toBeUndefined();
  expect(mocks.getOwner).not.toHaveBeenCalled();
});

it.each(['success', 'failure'])(
  'a late HTTP %s cannot overwrite a newer snapshot or reject it',
  async (outcome) => {
    let resolve!: (value: AgentConversationOwnerResponse) => void;
    let reject!: (error: Error) => void;
    mocks.getOwner.mockReturnValueOnce(
      new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
    );
    const read = refreshConversationOwner('child', 'node-agent', 'thread');
    observe();
    const latest = { ...owner, spaceTitle: 'Pushed' };
    receive(snapshot(1, latest));
    if (outcome === 'success') resolve(owner);
    else reject(new ApiError(503, {}, 'Old read failed'));
    await expect(read).resolves.toEqual(latest);
    expect(
      useRemoteConversationOwnerStore.getState().entries[key]?.owner,
    ).toEqual(latest);
  },
);

it('a late successful query cannot resurrect a deleted owner', async () => {
  let resolve!: (value: AgentConversationOwnerResponse) => void;
  mocks.getOwner.mockReturnValueOnce(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  const read = refreshConversationOwner('child', 'node-agent', 'thread');
  observe();
  receive({
    type: 'snapshot',
    data: {
      revision: 1,
      streamId: 'connection',
      value: {
        state: 'unavailable',
        status: 404,
        error: { message: 'Missing', code: 'conversation_owner_missing' },
      },
    },
  });
  resolve(owner);
  await expect(read).rejects.toMatchObject({ status: 404 });
  expect(
    useRemoteConversationOwnerStore.getState().entries[key]?.owner,
  ).toBeUndefined();
});

it('respects Retry-After despite focus and visibility events, then receives a full baseline', async () => {
  observe();
  fail(
    new ApiError(429, { details: { retryAfterSeconds: 5 } }, 'Rate limited'),
  );
  await vi.advanceTimersByTimeAsync(1000);
  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(3999);
  expect(mocks.stream).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.stream).toHaveBeenCalledTimes(2);
  receive(snapshot());
  expect(
    useRemoteConversationOwnerStore.getState().entries[key]?.error,
  ).toBeUndefined();
  expect(mocks.getOwner).not.toHaveBeenCalled();
});

it('keeps validated display metadata during an unexpected transport interruption', async () => {
  observe();
  receive(snapshot());
  fail(new Error('State stream ended'));
  await vi.advanceTimersByTimeAsync(0);
  expect(useRemoteConversationOwnerStore.getState().entries[key]).toMatchObject(
    {
      owner,
      lastKnownOwner: owner,
      error: 'State stream ended',
      errorStatus: 503,
    },
  );
});

it('keeps a shared explicit read alive until its last caller cancels', async () => {
  mocks.getOwner.mockImplementation(
    (_canvas, _thread, requestSignal: AbortSignal) =>
      new Promise((_resolve, reject) =>
        requestSignal.addEventListener('abort', () =>
          reject(requestSignal.reason),
        ),
      ),
  );
  const a = new AbortController();
  const b = new AbortController();
  const first = refreshConversationOwner('child', 'node-agent', 'thread', {
    signal: a.signal,
  });
  const second = refreshConversationOwner('child', 'node-agent', 'thread', {
    signal: b.signal,
  });
  const firstRejected = expect(first).rejects.toMatchObject({
    name: 'AbortError',
  });
  a.abort();
  await firstRejected;
  expect(mocks.getOwner.mock.calls[0][2].aborted).toBe(false);
  const secondRejected = expect(second).rejects.toMatchObject({
    name: 'AbortError',
  });
  b.abort();
  await secondRejected;
  expect(mocks.getOwner.mock.calls[0][2].aborted).toBe(true);
});
