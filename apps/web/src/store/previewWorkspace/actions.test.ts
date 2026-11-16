// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/_client';
import { getAgentConversationOwner } from '@/api/agent';
import useCanvasStore from '@/store/canvasStore';

import {
  openConversationThread,
  openSpaceConversation,
  openPdfNotes,
  openPreviewNode,
  openFileReference,
} from './actions';
import { createEmptyWorkspace } from './model';
import { usePreviewWorkspaceStore } from './store';

import type * as AgentApi from '@/api/agent';
import type { AddNodeInput } from '@/handler/canvasCommand/uiIntent';

const originalAddNode = useCanvasStore.getState().addNode;
afterEach(() => {
  useCanvasStore.setState({ addNode: originalAddNode });
});

vi.mock('@/api/agent', async (original) => ({
  ...(await original<typeof AgentApi>()),
  getAgentConversationOwner: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(getAgentConversationOwner).mockReset();
  useCanvasStore.setState({
    canvasId: 'space',
    isLoading: false,
    canvasAccess: { canvasId: 'space', write: true, manage: true },
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

const reference = { agentletId: 'device-a', path: '/root/code.py' };
const fileNode = (id: string, agentletId = reference.agentletId) => ({
  id,
  type: 'fileReference',
  position: { x: 10, y: 20 },
  data: {
    fileReference: { ...reference, agentletId },
    label: 'Original label',
  },
});

it('creates one visible metadata-only reference and reuses a permanent tab on repeated activation', () => {
  const add = vi.fn((input: AddNodeInput) => {
    if (!input.id) throw new Error('Expected an explicit reference ID');
    const id = input.id;
    useCanvasStore.setState((state) => ({
      nodes: [
        ...state.nodes,
        {
          id,
          type: input.nodeType,
          position: { x: 0, y: 0 },
          data: input.data ?? {},
        },
      ],
    }));
  });
  useCanvasStore.setState({ addNode: add });
  const tab = openFileReference('space', reference, 'code.py');
  expect(openFileReference('space', reference, 'code.py')).toBe(tab);
  expect(add).toHaveBeenCalledOnce();
  expect(add.mock.calls[0][0]).toMatchObject({
    nodeType: 'fileReference',
    data: {
      fileReference: reference,
      label: 'code.py',
      origin: { type: 'user-created' },
    },
  });
  expect(add.mock.calls[0][0].data).not.toHaveProperty('content');
  expect(add.mock.calls[0][0]).not.toHaveProperty('hidden');
  expect(
    usePreviewWorkspaceStore.getState().workspace.tabs[tab].transient,
  ).toBe(false);
});

it('prefers an open matching reference without moving, renaming or deleting existing nodes', () => {
  const nodes = [
    fileNode('first'),
    fileNode('second'),
    fileNode('other-device', 'device-b'),
  ];
  useCanvasStore.setState({ nodes });
  const tab = openPreviewNode('second');
  expect(openFileReference('space', reference, 'New label')).toBe(tab);
  expect(useCanvasStore.getState().nodes).toBe(nodes);
  expect(
    usePreviewWorkspaceStore.getState().workspace.tabs[tab].transient,
  ).toBe(false);
});

it('opens existing references read-only but rejects creation, stale Spaces and failed node creation', () => {
  const add = vi.fn();
  useCanvasStore.setState({
    nodes: [fileNode('existing')],
    addNode: add,
    canvasAccess: { canvasId: 'space', write: false, manage: false },
  });
  expect(openFileReference('space', reference, 'code.py')).toBeTruthy();
  expect(() =>
    openFileReference(
      'space',
      { ...reference, agentletId: 'another-device' },
      'code.py',
    ),
  ).toThrow();
  expect(() =>
    openFileReference('other-space', reference, 'code.py'),
  ).toThrow();
  expect(add).not.toHaveBeenCalled();
  useCanvasStore.setState({
    canvasAccess: { canvasId: 'space', write: true, manage: true },
  });
  const before = usePreviewWorkspaceStore.getState().workspace;
  expect(() =>
    openFileReference(
      'space',
      { ...reference, path: '/missing.txt' },
      'missing.txt',
    ),
  ).toThrow();
  expect(usePreviewWorkspaceStore.getState().workspace).toBe(before);
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
