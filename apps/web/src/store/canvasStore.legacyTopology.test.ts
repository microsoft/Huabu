// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stripLegacyPortalTopology } from '@huabu/shared';

const api = vi.hoisted(() => ({
  getCanvas: vi.fn(),
  postCanvasExecute: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof canvasApi>()),
  ...api,
}));

/** Node ids this page asked the server to delete (through `execute`). */
function sentDeletions(): string[] {
  return api.postCanvasExecute.mock.calls.flatMap(([, request]) =>
    (
      (request as PostCanvasExecuteRequest).commands as Array<{
        type: string;
        nodeIds?: string[];
      }>
    ).flatMap((command) =>
      command.type === 'DELETE_NODES' ? (command.nodeIds ?? []) : [],
    ),
  );
}

import { useAcpProfilesStore } from './acpProfilesStore';
import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore from './canvasStore';
import { useChatStore } from './chatStore';
import { ApiError } from '../api/_client';
import { createFakeSpaceServer } from './canvasStore/sync/testing/fakeExecuteServer';
import { usePreviewWorkspaceStore } from './previewWorkspace/store';
import * as notifications from '../components/Common/Toast';

import type * as canvasApi from '../api';
import type { PostCanvasExecuteRequest } from '@huabu/shared';
import type { Edge, Node } from '@xyflow/react';

function storedGraph(): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: [
      {
        id: 'portal',
        type: 'canvasRef',
        position: { x: 100, y: 200 },
        data: {},
      },
      {
        id: 'pin',
        type: 'frameRef',
        parentId: 'portal',
        position: { x: 20, y: 30 },
        data: {},
      },
      {
        id: 'ref',
        type: 'nodeRef',
        parentId: 'pin',
        position: { x: 0, y: 0 },
        data: {},
      },
      {
        id: 'frame',
        type: 'frame',
        parentId: 'pin',
        extent: 'parent',
        position: { x: 5, y: 6 },
        style: { width: 300, height: 200 },
        data: { type: 'frame', label: 'Frame', sizing: 'manual' },
      },
      {
        id: 'note',
        type: 'note',
        parentId: 'frame',
        position: { x: 7, y: 8 },
        style: { width: 150, height: 100 },
        data: {
          type: 'note',
          label: 'Note',
          heightMode: 'fixed',
          content: 'Keep this note',
        },
      },
      {
        id: 'preview',
        type: 'spacePreview',
        position: { x: 500, y: 600 },
        style: { width: 480, height: 320 },
        data: {
          type: 'spacePreview',
          targetCanvasId: 'canvas-target',
          label: 'Preview',
        },
      },
    ],
    edges: [
      { id: 'incident', source: 'ref', target: 'note' },
      { id: 'ordinary', source: 'note', target: 'preview' },
    ],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  canvasHistoryManager.activate('canvas-loaded', true);
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: '',
    nodes: [],
    edges: [],
    version: 0,
    isLoading: false,
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('legacy topology load boundary', () => {
  it('loads a non-AI Space without configuring or creating a Chat', async () => {
    useChatStore.setState({ threadMap: {} });
    useAcpProfilesStore.setState({ loaded: false, agentDefaults: null });
    usePreviewWorkspaceStore.setState({ canvasId: '' });
    api.getCanvas.mockResolvedValue({
      canvasId: 'non-ai-space',
      title: 'Non-AI',
      version: 1,
      state: { nodes: [], edges: [] },
    });
    await useCanvasStore.getState().loadCanvas('non-ai-space');
    expect(useCanvasStore.getState().canvasId).toBe('non-ai-space');
    expect(useCanvasStore.getState().isLoading).toBe(false);
    expect(useChatStore.getState().threadMap).toEqual({});
    expect(usePreviewWorkspaceStore.getState().workspace.tabs).toEqual({});
  });

  it('restores the legacy Chat identity without resolving new defaults', async () => {
    useChatStore.setState({
      threadMap: { 'legacy-chat-space': 'legacy-thread' },
      bindingByThread: { 'legacy-thread': { kind: 'internal' } },
    });
    useAcpProfilesStore.setState({ loaded: false, agentDefaults: null });
    usePreviewWorkspaceStore.setState({ canvasId: '' });
    api.getCanvas.mockResolvedValue({
      canvasId: 'legacy-chat-space',
      title: 'Legacy',
      version: 1,
      state: { nodes: [], edges: [] },
    });
    await useCanvasStore.getState().loadCanvas('legacy-chat-space');
    expect(useChatStore.getState().threadMap['legacy-chat-space']).toBe(
      'legacy-thread',
    );
    expect(
      Object.values(usePreviewWorkspaceStore.getState().workspace.tabs)[0]
        ?.target,
    ).toEqual({
      kind: 'chat',
      canvasId: 'legacy-chat-space',
      threadId: 'legacy-thread',
    });
    expect(useChatStore.getState().bindingByThread['legacy-thread']).toEqual({
      kind: 'internal',
    });
  });

  it('sends legacy Hug headers as geometry commands before completing load and not again on reopen', async () => {
    const graph = storedGraph();
    graph.nodes[3].data.sizing = 'hug';
    const before = JSON.stringify(graph);
    api.getCanvas.mockResolvedValue({
      canvasId: 'canvas-loaded',
      title: 'Loaded',
      version: 9,
      state: graph,
    });
    // The server as it stores the Space once it has read it: without the
    // retired topology. It runs the commands with the real engine.
    const kept = stripLegacyPortalTopology(graph.nodes, graph.edges);
    const server = createFakeSpaceServer();
    server.reset(kept.nodes as Node[], kept.edges as Edge[], 9);
    let acknowledge!: () => void;
    api.postCanvasExecute.mockImplementationOnce(
      (canvasId: string, request: PostCanvasExecuteRequest) =>
        new Promise((resolve) => {
          acknowledge = () => {
            const response = server.execute(canvasId, request);
            api.getCanvas.mockResolvedValue({
              canvasId: 'canvas-loaded',
              title: 'Loaded',
              version: response.toVersion,
              state: {
                nodes: server.state.nodes,
                edges: server.state.edges,
              },
            });
            resolve(response);
          };
        }),
    );
    const loading = useCanvasStore.getState().loadCanvas('canvas-loaded');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.postCanvasExecute).toHaveBeenCalledOnce();
    // Nothing is shown until the server has taken the change.
    expect(useCanvasStore.getState()).toMatchObject({
      isLoading: true,
      nodes: [],
      version: 0,
    });
    const sent = api.postCanvasExecute.mock.calls[0][1];
    expect(sent.originator.source).toBe('ui');
    expect(sent.commands).toEqual([
      {
        type: 'SET_NODE_GEOMETRY',
        items: expect.arrayContaining([
          expect.objectContaining({
            nodeId: 'note',
            position: expect.objectContaining({ y: 64 }),
          }),
          expect.objectContaining({
            nodeId: 'frame',
            position: expect.objectContaining({ y: 180 }),
          }),
        ]),
      },
    ]);
    acknowledge();
    await loading;
    await vi.advanceTimersByTimeAsync(2000);
    const loaded = useCanvasStore.getState();
    expect(loaded.nodes.find((node) => node.id === 'note')?.position.y).toBe(
      64,
    );
    expect(loaded.nodes.find((node) => node.id === 'frame')?.position.y).toBe(
      180,
    );
    expect(loaded.version).toBe(10);
    expect(loaded.isLoading).toBe(false);
    expect(api.postCanvasExecute).toHaveBeenCalledOnce();
    expect(JSON.stringify(graph)).toBe(before);

    await useCanvasStore.getState().loadCanvas('canvas-loaded');
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.postCanvasExecute).toHaveBeenCalledOnce();
  });

  it.each([
    new Error('Network unavailable'),
    new Error('Thread thread-existing has no canonical execution record'),
    new ApiError(403, { message: 'Read only' }, 'Read only'),
  ])(
    'loads the original geometry without retries or duplicate notifications when the header change is refused: %s',
    async (error) => {
      const graph = storedGraph();
      graph.nodes[3].data.sizing = 'hug';
      api.getCanvas.mockResolvedValue({
        canvasId: 'canvas-loaded',
        title: 'Loaded',
        version: 9,
        state: graph,
      });
      api.postCanvasExecute.mockRejectedValue(error);
      const consoleWarn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});
      const notify = vi.spyOn(notifications, 'toast');
      try {
        await useCanvasStore.getState().loadCanvas('canvas-loaded');
        await vi.advanceTimersByTimeAsync(2000);
        expect(useCanvasStore.getState()).toMatchObject({
          isLoading: false,
          canvasTitle: 'Loaded',
          version: 9,
        });
        const loaded = useCanvasStore.getState();
        expect(loaded.nodes.find((node) => node.id === 'frame')).toMatchObject({
          position: { x: 125, y: 236 },
        });
        expect(loaded.nodes.find((node) => node.id === 'note')).toMatchObject({
          position: { x: 7, y: 8 },
          data: { content: 'Keep this note' },
        });
        expect(loaded.edges).toEqual([graph.edges[1]]);
        expect(api.postCanvasExecute).toHaveBeenCalledOnce();
        expect(api.getCanvas).toHaveBeenCalledOnce();
        await useCanvasStore.getState().loadCanvas('canvas-loaded');
        await vi.advanceTimersByTimeAsync(2000);
        expect(useCanvasStore.getState().isLoading).toBe(false);
        expect(api.postCanvasExecute).toHaveBeenCalledTimes(2);
        expect(notify).not.toHaveBeenCalled();
      } finally {
        consoleWarn.mockRestore();
        notify.mockRestore();
      }
    },
  );
  it('ignores retired nodes without mutating stored data, issuing deletes, or saving on load', async () => {
    const graph = storedGraph();
    const before = JSON.stringify(graph);
    api.getCanvas.mockResolvedValue({
      canvasId: 'canvas-loaded',
      title: 'Loaded',
      version: 9,
      state: graph,
    });
    localStorage.setItem('legacy-topology-fixture', before);

    await useCanvasStore.getState().loadCanvas('canvas-loaded');
    await vi.advanceTimersByTimeAsync(2000);

    const loaded = useCanvasStore.getState();
    expect(loaded.nodes.map((node) => node.id)).toEqual([
      'frame',
      'note',
      'preview',
    ]);
    expect(loaded.nodes[0]).toMatchObject({ position: { x: 125, y: 236 } });
    expect(loaded.nodes[0]).not.toHaveProperty('parentId');
    expect(loaded.nodes[0]).not.toHaveProperty('extent');
    expect(loaded.nodes[1]).toMatchObject({
      parentId: 'frame',
      position: { x: 7, y: 8 },
      data: { content: 'Keep this note' },
    });
    expect(loaded.nodes[2]).toEqual({
      ...graph.nodes[5],
      data: { ...graph.nodes[5].data, widthMode: 'fixed' },
      style: { width: 480 },
      measured: { width: 480 },
    });
    expect(loaded.edges).toEqual([graph.edges[1]]);
    expect(loaded.version).toBe(9);
    expect(JSON.stringify(graph)).toBe(before);
    expect(localStorage.getItem('legacy-topology-fixture')).toBe(before);
    expect(sentDeletions()).toEqual([]);
  });

  it('pastes surviving ordinary content and Space previews through the store entry', () => {
    useCanvasStore
      .getState()
      ._setStateNoAutosave({ canvasId: 'canvas-loaded' });
    const graph = storedGraph();
    const before = JSON.stringify(graph);
    useCanvasStore
      .getState()
      .pasteNodes({ x: 165, y: 276 }, graph.nodes, graph.edges);
    const pasted = useCanvasStore.getState();
    expect(pasted.nodes.map((node) => node.type)).toEqual([
      'frame',
      'note',
      'spacePreview',
    ]);
    expect(pasted.nodes[0].position).toEqual({ x: 165, y: 276 });
    expect(pasted.nodes[1].parentId).toBe(pasted.nodes[0].id);
    expect(pasted.edges).toHaveLength(1);
    expect(JSON.stringify(graph)).toBe(before);
    expect(sentDeletions()).toEqual([]);
  });

  it('drops stale preview tabs after a matching load without losing unbound chats', async () => {
    const preview = usePreviewWorkspaceStore.getState();
    preview.loadForCanvas('canvas-loaded');
    preview.openPreviewTarget({
      kind: 'node',
      canvasId: 'canvas-loaded',
      nodeId: 'ref',
    });
    preview.openPreviewTarget({
      kind: 'chat',
      canvasId: 'canvas-loaded',
      threadId: 'thread-keep',
    });
    api.getCanvas.mockResolvedValue({
      canvasId: 'canvas-loaded',
      title: 'Loaded',
      version: 9,
      state: storedGraph(),
    });

    await useCanvasStore.getState().loadCanvas('canvas-loaded');

    const targets = Object.values(
      usePreviewWorkspaceStore.getState().workspace.tabs,
    ).map((tab) => tab.target);
    expect(targets).not.toContainEqual({
      kind: 'node',
      canvasId: 'canvas-loaded',
      nodeId: 'ref',
    });
    expect(targets).toContainEqual({
      kind: 'chat',
      canvasId: 'canvas-loaded',
      threadId: 'thread-keep',
    });
  });
});
