// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/_client';
import { getAgentConversationOwner } from '@/api/agent';
import useCanvasStore from '@/store/canvasStore';

import {
  openConversationThread,
  openSpaceConversation,
  openPdfNotes,
  openPreviewNode,
} from './actions';
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
  (kind) => {
    const tabId = usePreviewWorkspaceStore
      .getState()
      .openPreviewTarget(
        kind === 'node'
          ? { kind, canvasId: 'space', nodeId: 'agent' }
          : { kind, canvasId: 'space', nodeId: 'agent', threadId: 'thread' },
      );
    expect(openSpaceConversation('space', 'agent', 'thread')).toBe(tabId);
    expect(
      Object.keys(usePreviewWorkspaceStore.getState().workspace.tabs),
    ).toHaveLength(1);
  },
);

it('opens a new destination to the side when requested', () => {
  usePreviewWorkspaceStore.getState().openPreviewTarget({
    kind: 'node',
    canvasId: 'space',
    nodeId: 'source',
  });
  const tabId = openSpaceConversation('space', 'agent', 'thread', {
    openToSide: true,
  });
  const { workspace, chatOpenRequest } = usePreviewWorkspaceStore.getState();
  expect(workspace.groups).toHaveLength(2);
  expect(workspace.tabs[tabId].target).toEqual({
    kind: 'conversation',
    canvasId: 'space',
    nodeId: 'agent',
    threadId: 'thread',
  });
  expect(chatOpenRequest?.tabId).toBe(tabId);
});

it('opens the real owned Note beside the PDF without duplicating nodes or tabs', () => {
  useCanvasStore.setState({
    nodes: [
      {
        id: 'pdf',
        type: 'pdf',
        position: { x: 0, y: 0 },
        data: { noteNodeId: 'notes' },
      },
      {
        id: 'notes',
        type: 'note',
        hidden: true,
        position: { x: 0, y: 0 },
        data: { content: 'My notes' },
      },
    ],
  });

  const noteTab = openPdfNotes('pdf');
  expect(openPdfNotes('pdf')).toBe(noteTab);
  const { workspace, nodeFocusRequest } = usePreviewWorkspaceStore.getState();
  expect(workspace.groups).toHaveLength(2);
  expect(Object.values(workspace.tabs)).toHaveLength(2);
  expect(workspace.groups.every((group) => group.tabIds.length === 1)).toBe(
    true,
  );
  expect(Object.values(workspace.tabs).every((tab) => !tab.transient)).toBe(
    true,
  );
  expect(nodeFocusRequest?.tabId).toBe(noteTab);
  expect(workspace.tabs[noteTab].target).toEqual({
    kind: 'node',
    canvasId: 'space',
    nodeId: 'notes',
  });
  expect(useCanvasStore.getState().nodes).toHaveLength(2);
});

it('reuses PDF notes for search without retaining an editor-focus request', () => {
  useCanvasStore.setState({
    nodes: [{ id: 'notes', type: 'note', position: { x: 0, y: 0 }, data: {} }],
  });
  const searchTab = openPreviewNode('notes', {
    focusEditor: false,
  });
  expect(
    usePreviewWorkspaceStore.getState().workspace.tabs[searchTab],
  ).toMatchObject({
    target: { kind: 'node', canvasId: 'space', nodeId: 'notes' },
    transient: true,
  });
  usePreviewWorkspaceStore.getState().requestNodeFocus(searchTab);
  expect(openPreviewNode('notes', { focusEditor: false })).toBe(searchTab);
  expect(usePreviewWorkspaceStore.getState().nodeFocusRequest).toBeNull();
  expect(
    Object.values(usePreviewWorkspaceStore.getState().workspace.tabs),
  ).toHaveLength(1);
});

it.each(['node', 'conversation'] as const)(
  'reuses an existing %s owner tab when opening a thread',
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
