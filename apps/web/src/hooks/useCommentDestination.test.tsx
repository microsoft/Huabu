// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { getRecentCanvasConversation } from '@/api/canvas';
import useCanvasStore from '@/store/canvasStore';

import { useCommentDestination } from './useCommentDestination';

import type * as CanvasApi from '@/api/canvas';

vi.mock('@/api/canvas', async (original) => ({
  ...(await original<typeof CanvasApi>()),
  getRecentCanvasConversation: vi.fn(),
}));

let root: Root;
let host: HTMLDivElement;
let current: ReturnType<typeof useCommentDestination>;

function Harness({ canvasId = 'space' }: { canvasId?: string }) {
  current = useCommentDestination(canvasId);
  return null;
}

function owners(...ids: string[]) {
  useCanvasStore.setState({
    canvasId: 'space',
    pendingForkThreadIds: {},
    nodes: ids.map((id) => ({
      id,
      type: 'question',
      position: { x: 0, y: 0 },
      data: {
        threadId: `thread-${id}`,
        label: id,
        agentMode: 'ask',
        status: 'running',
      },
    })),
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(getRecentCanvasConversation).mockReset();
  vi.mocked(getRecentCanvasConversation).mockResolvedValue({
    conversation: null,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  owners();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('defaults to the sole existing conversation even when running or internal Ask', async () => {
  owners('a');
  await act(async () => root.render(<Harness />));
  expect(current.destination).toEqual({ nodeId: 'a', threadId: 'thread-a' });
  expect(current.available).toBe(true);
});

it.each([{ ids: [] }, { ids: ['a', 'b'] }])(
  'never creates a destination for candidates $ids',
  async ({ ids }) => {
    owners(...ids);
    await act(async () => root.render(<Harness />));
    expect(current.destination).toBeNull();
    expect(current.available).toBe(false);
    expect(current.loading).toBe(false);
  },
);

it('keeps an unavailable remembered owner instead of silently retargeting', async () => {
  owners('a');
  vi.mocked(getRecentCanvasConversation).mockResolvedValue({
    conversation: { nodeId: 'deleted', threadId: 'old-thread' },
  });
  await act(async () => root.render(<Harness />));
  expect(current.destination).toEqual({
    nodeId: 'deleted',
    threadId: 'old-thread',
  });
  expect(current.available).toBe(false);
  act(() => current.choose({ nodeId: 'a', threadId: 'thread-a' }));
  expect(current.available).toBe(true);
  act(() =>
    useCanvasStore.setState({
      pendingForkThreadIds: { 'thread-a': true },
    }),
  );
  expect(current.available).toBe(false);
  expect(current.destination?.nodeId).toBe('a');
});

it('does not silently rebind a selected node to a different thread', async () => {
  owners('a');
  await act(async () => root.render(<Harness />));
  act(() =>
    useCanvasStore.setState({
      nodes: [
        {
          id: 'a',
          type: 'question',
          position: { x: 0, y: 0 },
          data: { threadId: 'replacement' },
        },
      ],
    }),
  );
  expect(current.destination?.threadId).toBe('thread-a');
  expect(current.available).toBe(false);
});

it('preserves explicit choice against a delayed recent-default response', async () => {
  owners('a', 'b');
  let resolve!: (
    value: Awaited<ReturnType<typeof getRecentCanvasConversation>>,
  ) => void;
  vi.mocked(getRecentCanvasConversation).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => root.render(<Harness />));
  act(() => current.choose({ nodeId: 'b', threadId: 'thread-b' }));
  await act(async () =>
    resolve({ conversation: { nodeId: 'a', threadId: 'thread-a' } }),
  );
  expect(current.destination?.nodeId).toBe('b');
});

it('exposes read errors, supports retry and permits explicit existing choices', async () => {
  owners('a');
  vi.mocked(getRecentCanvasConversation).mockRejectedValueOnce(
    new Error('read failed'),
  );
  await act(async () => root.render(<Harness />));
  expect(current.destination).toBeNull();
  expect(current.error?.message).toBe('read failed');
  await act(async () => current.retry());
  expect(current.destination?.nodeId).toBe('a');
  expect(current.error).toBeNull();
});

it('ignores a response after the Space changes', async () => {
  owners('a');
  let resolve!: (
    value: Awaited<ReturnType<typeof getRecentCanvasConversation>>,
  ) => void;
  vi.mocked(getRecentCanvasConversation)
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce({ conversation: null });
  await act(async () => root.render(<Harness />));
  await act(async () => root.render(<Harness canvasId="other" />));
  await act(async () =>
    resolve({ conversation: { nodeId: 'old', threadId: 'old' } }),
  );
  expect(current.destination?.nodeId).not.toBe('old');
});
