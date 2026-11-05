// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/_client';
import { getAgentConversationOwner } from '@/api/agent';
import useCanvasStore from '@/store/canvasStore';

import { openConversationThread } from './actions';
import { createEmptyWorkspace } from './model';
import { usePreviewWorkspaceStore } from './store';

import type * as AgentApi from '@/api/agent';

vi.mock('@/api/agent', async (original) => ({
  ...(await original<typeof AgentApi>()),
  getAgentConversationOwner: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(getAgentConversationOwner).mockReset();
  useCanvasStore.setState({
    canvasId: 'space',
    isLoading: false,
    nodes: [
      {
        id: 'agent',
        type: 'question',
        position: { x: 0, y: 0 },
        data: { threadId: 'owned-thread' },
      },
    ],
  });
  usePreviewWorkspaceStore.setState({
    canvasId: 'space',
    workspace: createEmptyWorkspace('group'),
  });
});

it.each(['node', 'conversation'] as const)(
  'reuses an existing %s owner tab',
  async (kind) => {
    const tabId = usePreviewWorkspaceStore.getState().openPreviewTarget(
      kind === 'node'
        ? { kind, canvasId: 'space', nodeId: 'agent' }
        : {
            kind,
            canvasId: 'space',
            nodeId: 'agent',
            threadId: 'owned-thread',
          },
    );
    expect(await openConversationThread('space', 'owned-thread')).toBe(tabId);
    expect(
      Object.keys(usePreviewWorkspaceStore.getState().workspace.tabs),
    ).toHaveLength(1);
    expect(getAgentConversationOwner).not.toHaveBeenCalled();
  },
);

it('opens the current owner when no tab exists', async () => {
  const tabId = await openConversationThread('space', 'owned-thread');
  expect(
    usePreviewWorkspaceStore.getState().workspace.tabs[tabId].target,
  ).toEqual({
    kind: 'conversation',
    canvasId: 'space',
    nodeId: 'agent',
    threadId: 'owned-thread',
  });
});

it('keeps an unbound Chat unbound and reuses its tab', async () => {
  const first = await openConversationThread('space', 'chat');
  expect(await openConversationThread('space', 'chat')).toBe(first);
  expect(
    usePreviewWorkspaceStore.getState().workspace.tabs[first].target.kind,
  ).toBe('chat');
});

it('resolves a remote conversation owner before opening its source', async () => {
  vi.mocked(getAgentConversationOwner).mockResolvedValue({
    canvasId: 'remote',
    nodeId: 'remote-agent',
    threadId: 'thread',
    source: { hasAuthoredContent: false, agentBinding: { kind: 'internal' } },
    spaceTitle: 'Remote',
    observation: { epoch: 'epoch', revision: 1 },
  });
  const tabId = await openConversationThread('remote', 'thread');
  expect(
    usePreviewWorkspaceStore.getState().workspace.tabs[tabId].target,
  ).toEqual({
    kind: 'conversation',
    canvasId: 'remote',
    nodeId: 'remote-agent',
    threadId: 'thread',
  });
});

it('only treats the explicit missing-owner response as an unbound remote Chat', async () => {
  vi.mocked(getAgentConversationOwner).mockRejectedValue(
    new ApiError(404, { code: 'conversation_owner_missing' }, 'Unbound'),
  );
  const tabId = await openConversationThread('remote', 'thread');
  expect(
    usePreviewWorkspaceStore.getState().workspace.tabs[tabId].target.kind,
  ).toBe('chat');
});

it.each([
  'missing_node_content',
  'canvas_not_found',
  'conversation_owner_mismatch',
])('surfaces %s without opening an unbound fallback', async (code) => {
  vi.mocked(getAgentConversationOwner).mockRejectedValue(
    new ApiError(404, { code }, code),
  );

  await expect(openConversationThread('remote', 'thread')).rejects.toThrow(
    code,
  );
  expect(
    Object.keys(usePreviewWorkspaceStore.getState().workspace.tabs),
  ).toHaveLength(0);
});

it('does not open a source into a Space selected while its owner lookup was pending', async () => {
  vi.mocked(getAgentConversationOwner).mockImplementation(async () => {
    usePreviewWorkspaceStore.setState({ canvasId: 'other-space' });
    throw new ApiError(404, { code: 'conversation_owner_missing' }, 'Unbound');
  });
  await expect(openConversationThread('remote', 'thread')).rejects.toThrow(
    'active Space changed',
  );
  expect(
    Object.keys(usePreviewWorkspaceStore.getState().workspace.tabs),
  ).toHaveLength(0);
});
