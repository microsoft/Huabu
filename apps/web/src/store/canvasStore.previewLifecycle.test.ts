// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import useCanvasStore from './canvasStore';
import { usePanelStore } from './panelStore';
import {
  closeActivePreviewNode,
  openPreviewNode,
  openPreviewUrl,
  openSpaceConversation,
} from './previewWorkspace/actions';
import { createEmptyWorkspace } from './previewWorkspace/model';
import { usePreviewWorkspaceStore } from './previewWorkspace/store';

import type * as PreprocessQueueModule from './canvasStore/save/preprocessQueue';

const { schedule } = vi.hoisted(() => ({ schedule: vi.fn() }));
vi.mock('./canvasStore/save/preprocessQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof PreprocessQueueModule>();
  return {
    ...actual,
    createPreprocessQueue: (
      ...args: Parameters<typeof actual.createPreprocessQueue>
    ) => ({ ...actual.createPreprocessQueue(...args), schedule }),
  };
});

const preview = () => usePreviewWorkspaceStore.getState();
const node = (id: string, type = 'note') => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { content: '# Updated title', label: 'Old title' },
});
const scheduledIds = () => schedule.mock.calls.map(([value]) => value.id);

beforeEach(() => {
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: '',
    nodes: [],
    edges: [],
  });
  usePreviewWorkspaceStore.setState({
    canvasId: 'parent',
    workspace: createEmptyWorkspace(),
    nodeFocusRequest: null,
    chatOpenRequest: null,
    readIntentByTab: {},
  });
  usePanelStore.setState({ isRightCollapsed: false });
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: 'parent',
    nodes: [
      node('note'),
      node('other'),
      node('text', 'text'),
      node('pdf', 'pdf'),
    ],
  });
  schedule.mockClear();
});

describe('preview editor departure', () => {
  it('settles a Note once when a Space conversation opens, retaining the Note tab', () => {
    const noteTab = openPreviewNode('note', { transient: false });
    const chatTab = openSpaceConversation('child', 'agent', 'thread');
    expect(scheduledIds()).toEqual(['note']);
    expect(preview().workspace.tabs[noteTab].target).toMatchObject({
      nodeId: 'note',
    });
    expect(preview().workspace.groups[0].activeTabId).toBe(chatTab);
  });

  it('settles only the destination editor when reusing a conversation in another group', () => {
    const conversation = openSpaceConversation('child', 'agent', 'thread');
    const noteTab = openPreviewNode('note', { transient: false });
    preview().splitGroup();
    const otherTab = openPreviewNode('other', { transient: false });
    schedule.mockClear();

    expect(openSpaceConversation('child', 'agent', 'thread')).toBe(
      conversation,
    );
    expect(scheduledIds()).toEqual(['note']);
    expect(preview().workspace.tabs[noteTab]).toBeDefined();
    expect(
      preview().workspace.groups.some(
        (group) => group.activeTabId === otherTab,
      ),
    ).toBe(true);
  });

  it.each(['note', 'text'])(
    'settles %s on direct activation and active close, not inactive close',
    (id) => {
      const first = openPreviewNode(id, { transient: false });
      const second = openPreviewNode('other', { transient: false });
      expect(scheduledIds()).toEqual([id]);
      schedule.mockClear();
      preview().activateTab(first);
      expect(scheduledIds()).toEqual(['other']);
      schedule.mockClear();
      preview().closeTab(second);
      expect(schedule).not.toHaveBeenCalled();
      closeActivePreviewNode();
      expect(scheduledIds()).toEqual([id]);
    },
  );

  it('settles transient replacement and URL navigation through the same boundary', () => {
    const transient = openPreviewNode('note');
    expect(openPreviewNode('other')).toBe(transient);
    expect(scheduledIds()).toEqual(['note']);
    schedule.mockClear();
    openPreviewUrl('https://example.com', 'other');
    expect(scheduledIds()).toEqual(['other']);
  });

  it('settles both active split editors on collapse, but not repeated collapse or reopening', () => {
    openPreviewNode('note', { transient: false });
    preview().splitGroup();
    openPreviewNode('other', { transient: false });
    schedule.mockClear();
    usePanelStore.getState().setRightCollapsed(true);
    expect(scheduledIds()).toEqual(['note', 'other']);
    schedule.mockClear();
    usePanelStore.getState().setRightCollapsed(true);
    usePanelStore.getState().requestOpenRightPanel();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('does not settle still-visible editors on group focus, reordering, or unrelated state changes', () => {
    const first = openPreviewNode('note', { transient: false });
    const firstGroup = preview().workspace.activeGroupId;
    preview().splitGroup();
    openPreviewNode('other', { transient: false });
    schedule.mockClear();
    preview().setActiveGroup(firstGroup);
    preview().activateTab(first);
    preview().moveTab(first, { groupId: firstGroup, index: 0 });
    preview().setSplitRatio(0.6);
    preview().requestNodeFocus(first);
    usePanelStore.getState().setRightWidthPx(500);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('settles each editor when a cross-group move and activation make it inactive', () => {
    const first = openPreviewNode('note', { transient: false });
    preview().splitGroup();
    const destination = preview().workspace.activeGroupId;
    openPreviewNode('other', { transient: false });
    schedule.mockClear();
    preview().moveTab(first, { groupId: destination });
    expect(scheduledIds()).toEqual(['note']);
    preview().activateTab(first);
    expect(scheduledIds()).toEqual(['note', 'other']);
  });

  it.each(['merge', 'close-group'])(
    'settles editors leaving during %s',
    (operation) => {
      const first = openPreviewNode('note', { transient: false });
      preview().splitGroup();
      openPreviewNode('other', { transient: false });
      schedule.mockClear();
      if (operation === 'merge') {
        preview().mergeGroups();
        expect(scheduledIds()).toEqual(['other']);
      } else {
        preview().closeTabs(first, 'group');
        expect(scheduledIds()).toEqual(['note']);
      }
    },
  );

  it('ignores read-only nodes and never settles a same-ID node in a different Space', () => {
    openPreviewNode('pdf', { transient: false });
    openSpaceConversation('child', 'agent', 'thread');
    expect(schedule).not.toHaveBeenCalled();
    openPreviewNode('note', { transient: false });
    useCanvasStore.getState()._setStateNoAutosave({ canvasId: 'different' });
    openSpaceConversation('child', 'agent', 'thread');
    expect(schedule).not.toHaveBeenCalled();
  });
});
