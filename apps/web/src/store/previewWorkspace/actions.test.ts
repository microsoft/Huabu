// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, expect, it } from 'vitest';

import { openSpaceConversation } from './actions';
import { createEmptyWorkspace } from './model';
import { usePreviewWorkspaceStore } from './store';

beforeEach(() => {
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
