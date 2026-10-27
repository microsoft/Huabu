// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore from './canvasStore';
import { useWorkspaceStore } from './workspaceStore';
import * as api from '../api';
import * as notifications from '../components/Common/Toast';
import { REQUEST_DELETE_SPACE } from '../utils/spaceHierarchy';

import type { Delta } from '@huabu/shared/canvas-engine';
import type { Node } from '@xyflow/react';

const entry: Node = {
  id: 'node-entry',
  type: 'spacePreview',
  position: { x: 0, y: 0 },
  data: { targetCanvasId: 'child' },
};
const originalRefresh = useWorkspaceStore.getState().refreshSpaceTitles;
const refresh = vi.fn(async () => undefined);
const edge = {
  id: 'edge-other',
  source: 'node-a',
  target: 'node-b',
  selected: true,
};
const endpoints: Node[] = ['node-a', 'node-b'].map((id) => ({
  id,
  type: 'note',
  position: { x: 0, y: 0 },
  data: { content: id },
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.spyOn(api, 'deleteNode').mockResolvedValue({ success: true });
  vi.spyOn(notifications, 'toast').mockImplementation(() => '');
  canvasHistoryManager.activate('parent', true);
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: 'parent',
    nodes: [],
    edges: [],
    version: 0,
    isLoading: false,
    isSaving: false,
    pendingSave: false,
  });
  useWorkspaceStore.setState({
    workspaceId: 'workspace',
    isReady: true,
    isSyncing: false,
    spaceTitles: { child: 'Child' },
    spaceSummaries: {},
    spaceTitlesStatus: 'loading',
    refreshSpaceTitles: refresh,
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useWorkspaceStore.setState({ refreshSpaceTitles: originalRefresh });
});

function knowChild() {
  useWorkspaceStore.setState({
    spaceTitlesStatus: 'ready',
    spaceSummaries: {
      child: { parentSpaceId: 'parent', parentEntryNodeId: entry.id },
    },
  });
}

it('does not undo a newly received child entry before or after ownership metadata arrives', async () => {
  useCanvasStore
    .getState()
    .applyDeltasFromAgent([{ type: 'INSERT_NODE', node: entry } as Delta], 1, {
      mutatedNodes: [],
      deletedNodeIds: [],
      contentEditedNodeIds: [],
      deferredFitFrameIds: [],
    });
  refresh.mockClear();
  await useCanvasStore.getState().undo();
  expect(refresh).toHaveBeenCalledOnce();
  expect(useCanvasStore.getState().nodes).toHaveLength(1);
  expect(canvasHistoryManager.canUndo).toBe(true);
  knowChild();
  await useCanvasStore.getState().undo();
  expect(useCanvasStore.getState().nodes[0].id).toBe(entry.id);
  expect(api.deleteNode).not.toHaveBeenCalled();
  expect(notifications.toast).toHaveBeenCalled();
});

it('allows geometry undo and redo for canonical entries', async () => {
  knowChild();
  canvasHistoryManager.takeSnapshot([entry], []);
  useCanvasStore.getState()._setStateNoAutosave({
    nodes: [{ ...entry, position: { x: 50, y: 60 } }],
  });
  await useCanvasStore.getState().undo();
  expect(useCanvasStore.getState().nodes[0].position).toEqual(entry.position);
  await useCanvasStore.getState().redo();
  expect(useCanvasStore.getState().nodes[0].position).toEqual({ x: 50, y: 60 });
  expect(notifications.toast).not.toHaveBeenCalled();
});

it.each(['loading', 'error', 'ready'] as const)(
  'blocks a Frame deletion before deleting any ordinary descendants when ownership is missing (%s)',
  (spaceTitlesStatus) => {
    useWorkspaceStore.setState({ spaceTitlesStatus });
    const nodes: Node[] = [
      { id: 'node-frame', type: 'frame', position: { x: 0, y: 0 }, data: {} },
      { ...entry, parentId: 'node-frame' },
      {
        id: 'node-note',
        type: 'note',
        parentId: 'node-frame',
        position: { x: 0, y: 0 },
        data: { content: 'Keep' },
      },
    ];
    nodes.push(...endpoints);
    useCanvasStore.getState()._setStateNoAutosave({ nodes, edges: [edge] });
    useCanvasStore.getState().deleteNodes(['node-frame'], [edge.id]);
    expect(useCanvasStore.getState().nodes).toEqual(nodes);
    expect(useCanvasStore.getState().edges).toEqual([edge]);
    expect(api.deleteNode).not.toHaveBeenCalled();
    expect(canvasHistoryManager.hasPendingDeletes('parent')).toBe(false);
    expect(refresh).toHaveBeenCalledOnce();
  },
);

it('defers the complete mixed node/edge deletion while child confirmation is pending', () => {
  knowChild();
  const nodes = [entry, ...endpoints];
  useCanvasStore.getState()._setStateNoAutosave({ nodes, edges: [edge] });
  const confirm = vi.fn();
  window.addEventListener(REQUEST_DELETE_SPACE, confirm);
  try {
    expect(useCanvasStore.getState().deleteNodes([entry.id], [edge.id])).toBe(
      false,
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(useCanvasStore.getState().nodes).toEqual(nodes);
    expect(useCanvasStore.getState().edges).toEqual([edge]);
    expect(api.deleteNode).not.toHaveBeenCalled();
    expect(canvasHistoryManager.canUndo).toBe(false);
  } finally {
    window.removeEventListener(REQUEST_DELETE_SPACE, confirm);
  }
});

it('keeps selected edges when deleting a Frame with a known child entry is refused', () => {
  knowChild();
  const nodes = [
    { id: 'node-frame', type: 'frame', position: { x: 0, y: 0 }, data: {} },
    { ...entry, parentId: 'node-frame' },
    ...endpoints,
  ];
  useCanvasStore.getState()._setStateNoAutosave({ nodes, edges: [edge] });
  expect(useCanvasStore.getState().deleteNodes(['node-frame'], [edge.id])).toBe(
    false,
  );
  expect(useCanvasStore.getState().nodes).toEqual(nodes);
  expect(useCanvasStore.getState().edges).toEqual([edge]);
  expect(api.deleteNode).not.toHaveBeenCalled();
  expect(notifications.toast).toHaveBeenCalled();
  expect(canvasHistoryManager.canUndo).toBe(false);
});

it('deletes ordinary nodes and selected edges in one undoable execution', async () => {
  const note: Node = {
    id: 'node-note',
    type: 'note',
    position: { x: 0, y: 0 },
    data: { content: 'Ordinary' },
  };
  const nodes = [note, ...endpoints];
  useCanvasStore.getState()._setStateNoAutosave({ nodes, edges: [edge] });
  expect(useCanvasStore.getState().deleteNodes([note.id], [edge.id])).toBe(
    true,
  );
  expect(useCanvasStore.getState().nodes).toEqual(endpoints);
  expect(useCanvasStore.getState().edges).toEqual([]);
  await canvasHistoryManager.waitForDeletes('parent');
  await useCanvasStore.getState().undo();
  expect(useCanvasStore.getState().nodes).toEqual(nodes);
  expect(useCanvasStore.getState().edges).toEqual([
    { id: edge.id, source: edge.source, target: edge.target },
  ]);
  expect(canvasHistoryManager.canUndo).toBe(false);
});

it('also protects direct command deletion instead of relying on UI Delete', () => {
  knowChild();
  useCanvasStore.getState()._setStateNoAutosave({ nodes: [entry] });
  useCanvasStore
    .getState()
    .executeCommands([{ type: 'DELETE_NODES', nodeIds: ['node-entry'] }]);
  expect(useCanvasStore.getState().nodes).toEqual([entry]);
  expect(api.deleteNode).not.toHaveBeenCalled();
});

it('does not consume a redo snapshot that would remove a now-canonical entry', async () => {
  useWorkspaceStore.setState({
    spaceTitlesStatus: 'ready',
    spaceSummaries: { child: { parentSpaceId: null, parentEntryNodeId: null } },
  });
  canvasHistoryManager.takeSnapshot([entry], []);
  await useCanvasStore.getState().undo();
  knowChild();
  await useCanvasStore.getState().redo();
  expect(useCanvasStore.getState().nodes).toEqual([entry]);
  expect(canvasHistoryManager.canRedo).toBe(true);
  expect(api.deleteNode).not.toHaveBeenCalled();
});

it('lets a confirmed missing-target shortcut be deleted after metadata settles', async () => {
  useWorkspaceStore.setState({ spaceTitlesStatus: 'ready', spaceTitles: {} });
  useCanvasStore.getState()._setStateNoAutosave({ nodes: [entry] });
  useCanvasStore
    .getState()
    .dispatchUiIntent({ type: 'DELETE_NODES', nodeIds: [entry.id] });
  expect(useCanvasStore.getState().nodes).toEqual([]);
  await canvasHistoryManager.waitForDeletes('parent');
  expect(api.deleteNode).toHaveBeenCalledWith('parent', entry.id);
});
