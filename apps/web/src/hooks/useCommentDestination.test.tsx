// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, Activity } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { getRecentCanvasConversation } from '@/api/canvas';
import useCanvasStore from '@/store/canvasStore';
import {
  rememberPreviewedAgent,
  useCommentDestinationMemory,
} from '@/store/commentDestinationMemory';
import { useWorkspaceStore } from '@/store/workspaceStore';

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
  useCanvasStore.setState({ canvasId: '', isLoading: false });
  useWorkspaceStore.setState({
    workspaceId: 'workspace',
    workspacePath: '/workspace',
    isSyncing: false,
  });
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

it('waits for the initial Space load before resolving a default', async () => {
  owners('a');
  useCanvasStore.setState({ isLoading: true });
  await act(async () => root.render(<Harness />));
  expect(getRecentCanvasConversation).not.toHaveBeenCalled();
  await act(async () => useCanvasStore.setState({ isLoading: false }));
  expect(current.destination?.nodeId).toBe('a');
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

it('preserves explicit New intent against a delayed recent-default response', async () => {
  owners('a');
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
  act(() => current.choose(null));
  await act(async () =>
    resolve({ conversation: { nodeId: 'a', threadId: 'thread-a' } }),
  );
  expect(current.destination).toBeNull();
  expect(current.loading).toBe(false);
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

function preview(nodeId: string) {
  rememberPreviewedAgent({ kind: 'node', canvasId: 'space', nodeId });
}

it('uses preview intent ahead of messaging, ignores Canvas selection, and retains intent across file opens', async () => {
  owners('a', 'b', 'c');
  useCanvasStore.setState({
    nodes: useCanvasStore.getState().nodes.map((node) => ({
      ...node,
      selected: node.id === 'a',
    })),
  });
  vi.mocked(getRecentCanvasConversation).mockResolvedValue({
    conversation: { nodeId: 'a', threadId: 'thread-a' },
  });
  preview('b');
  rememberPreviewedAgent({ kind: 'node', canvasId: 'space', nodeId: 'file' });
  await act(async () => root.render(<Harness />));
  expect(current.destination?.nodeId).toBe('b');
  expect(getRecentCanvasConversation).not.toHaveBeenCalled();
});

it('only successful staging remembers picker choices and wins over later preview activity after remount', async () => {
  owners('a', 'b', 'c');
  preview('a');
  await act(async () => root.render(<Harness key="first" />));
  act(() => current.choose({ nodeId: 'b', threadId: 'thread-b' }));
  await act(async () => root.render(<Harness key="cancelled" />));
  expect(current.destination?.nodeId).toBe('a');
  act(() => {
    current.choose({ nodeId: 'b', threadId: 'thread-b' });
  });
  act(() => current.rememberStaged('thread-b'));
  preview('c');
  await act(async () => root.render(<Harness key="next-comment" />));
  expect(current.destination?.nodeId).toBe('b');
  act(() => current.choose({ nodeId: 'a', threadId: 'thread-a' }));
  expect(current.destination?.nodeId).toBe('a');
});

it('preserves a choice through Activity hide/show without re-reading defaults', async () => {
  owners('a', 'b');
  const render = (mode: 'visible' | 'hidden') =>
    act(async () =>
      root.render(
        <Activity mode={mode}>
          <Harness />
        </Activity>,
      ),
    );
  await render('visible');
  act(() => current.choose({ nodeId: 'b', threadId: 'thread-b' }));
  await render('hidden');
  preview('a');
  await render('visible');
  expect(current.destination?.nodeId).toBe('b');
  expect(getRecentCanvasConversation).toHaveBeenCalledTimes(1);
});

it('keeps destination and candidate order stable under background activity and preview changes', async () => {
  owners('z', 'b', 'a');
  preview('b');
  await act(async () => root.render(<Harness />));
  expect(current.candidates.map((item) => item.nodeId)).toEqual([
    'b',
    'a',
    'z',
  ]);
  act(() => {
    preview('z');
    useCanvasStore.setState({
      nodes: [...useCanvasStore.getState().nodes].reverse().map((node) => ({
        ...node,
        data: { ...node.data, lastActivityAt: node.id === 'z' ? 100 : 0 },
      })),
    });
  });
  expect(current.destination?.nodeId).toBe('b');
  expect(current.candidates.map((item) => item.nodeId)).toEqual([
    'b',
    'a',
    'z',
  ]);
  await act(async () => root.render(<Harness key="next" />));
  expect(current.destination?.nodeId).toBe('z');
});

it('requires explicit choice after staging in a temporary chat, without reviving an older Agent', async () => {
  owners('a', 'b');
  preview('a');
  await act(async () => root.render(<Harness />));
  act(() => current.choose(null));
  act(() => current.rememberStaged('temporary-thread'));
  preview('b');
  await act(async () => root.render(<Harness key="next" />));
  expect(current.destination).toBeNull();
  expect(current.temporary).toBe(true);
  expect(current.loading).toBe(false);
  expect(current.available).toBe(false);
  act(() => current.choose({ nodeId: 'b', threadId: 'thread-b' }));
  expect(current.temporary).toBe(false);
  expect(current.resolve()?.conversationOwner.threadId).toBe('thread-b');
});

it('does not replace a deleted remembered comment owner with a preview or sole remaining owner', async () => {
  owners('a', 'b');
  preview('a');
  await act(async () => root.render(<Harness />));
  act(() => current.rememberStaged('thread-a'));
  act(() => owners('b'));
  preview('b');
  await act(async () => root.render(<Harness key="next" />));
  expect(current.destination?.nodeId).toBe('a');
  expect(current.available).toBe(false);
  expect(current.resolve()).toBeNull();
});

it.each(['space', 'workspace'] as const)(
  'fences old forms and requests across a %s round trip, even with identical owner IDs',
  async (kind) => {
    owners('a', 'b');
    let resolve!: (
      value: Awaited<ReturnType<typeof getRecentCanvasConversation>>,
    ) => void;
    vi.mocked(getRecentCanvasConversation).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await act(async () => root.render(<Harness />));
    const old = current;
    act(() => {
      if (kind === 'space') {
        useCanvasStore.setState({ canvasId: 'other' });
        useCanvasStore.setState({ canvasId: 'space' });
      } else {
        useWorkspaceStore.setState({ workspaceId: 'other' });
        useWorkspaceStore.setState({ workspaceId: 'workspace' });
      }
    });
    await act(async () =>
      resolve({ conversation: { nodeId: 'a', threadId: 'thread-a' } }),
    );
    expect(current.scopeValid).toBe(false);
    expect(old.isCurrent()).toBe(false);
    expect(old.resolve()).toBeNull();
    act(() => {
      old.choose({ nodeId: 'b', threadId: 'thread-b' });
      old.rememberStaged('thread-b');
    });
    expect(useCommentDestinationMemory.getState().lastComment).toBeNull();
    await act(async () => root.render(<Harness key="fresh" />));
    expect(current.scopeValid).toBe(true);
    expect(current.destination).toBeNull();
  },
);

it('does not let Retry or an old rejected request replace a manual choice', async () => {
  owners('a', 'b');
  let reject!: (reason: Error) => void;
  vi.mocked(getRecentCanvasConversation).mockImplementationOnce(
    () =>
      new Promise((_done, fail) => {
        reject = fail;
      }),
  );
  await act(async () => root.render(<Harness />));
  act(() => current.choose({ nodeId: 'b', threadId: 'thread-b' }));
  await act(async () => {
    current.retry();
    reject(new Error('late failure'));
  });
  expect(current.destination?.nodeId).toBe('b');
  expect(current.error).toBeNull();
  expect(getRecentCanvasConversation).toHaveBeenCalledTimes(1);
});
