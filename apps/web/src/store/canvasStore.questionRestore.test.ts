// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

const {
  associateNode,
  deleteNode,
  putCanvas,
  putNodeContent,
  postCanvasExecute,
  forkThread,
} = vi.hoisted(() => ({
  associateNode: vi.fn(),
  deleteNode: vi.fn().mockResolvedValue({ success: true }),
  putCanvas: vi.fn(),
  putNodeContent: vi.fn(),
  postCanvasExecute: vi.fn(),
  forkThread: vi.fn(),
}));
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof CanvasApi>()),
  associateAgentNode: associateNode,
  deleteNode,
  putCanvas,
  postCanvasExecute,
  postCanvasEvents: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('../api/canvas', async (importOriginal) => ({
  ...(await importOriginal<typeof CanvasApi>()),
  putNodeContent,
  preprocessNode: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('../api/agent', () => ({ agentApi: { forkThread } }));

import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore, {
  awaitQuestionCreation,
  resetCanvasSyncForTests,
} from './canvasStore';
import { createFakeSpaceServer } from './canvasStore/sync/testing/fakeExecuteServer';

import type * as CanvasApi from '../api';
import type { PutNodeContentRequest } from '@huabu/shared';
import type { Node } from '@xyflow/react';

const question: Node = {
  id: 'node-restore',
  type: 'question',
  position: { x: 10, y: 20 },
  data: {
    content: 'Original intent',
    threadId: 'thread-restore',
    bindingState: 'bound',
    status: 'done',
    invocationToken: 'historical-token',
    viewed: false,
    agentBinding: { kind: 'internal' },
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  resetCanvasSyncForTests();
  associateNode.mockReset();
  deleteNode.mockClear();
  putCanvas.mockReset();
  postCanvasExecute.mockReset();
  putNodeContent.mockReset();
  putNodeContent.mockImplementation(
    async (
      _canvasId: string,
      nodeId: string,
      request: PutNodeContentRequest,
    ) => ({
      nodeId,
      label: null,
      rev: nodeRevisionOf({ content: request.content }),
    }),
  );
  forkThread.mockReset();
  canvasHistoryManager.activate('canvas-restore', true);
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: 'canvas-restore',
    nodes: [],
    edges: [],
    version: 1,
    isLoading: true,
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const pendingEffects = {
  mutatedNodes: [],
  deletedNodeIds: [],
  contentEditedNodeIds: [],
  deferredFitFrameIds: [],
};

function createQuestion(id: `node-${string}`): Node {
  useCanvasStore.getState().executeCommands([
    {
      type: 'CREATE_NODES',
      nodes: [
        {
          id,
          nodeType: 'question',
          position: { x: 0, y: 0 },
          data: { content: '', threadId: `thread-${id}` },
        },
      ],
    },
  ]);
  const node = useCanvasStore.getState().nodes.find((node) => node.id === id);
  if (!node) throw new Error('Question was not created optimistically');
  return node;
}

describe('Question creation settlement', () => {
  it('does not issue a redundant sidecar PUT for the optimistic Question', async () => {
    postCanvasExecute.mockResolvedValue({
      canvasId: 'canvas-restore',
      fromVersion: 1,
      toVersion: 2,
      results: [{ applied: true }],
      deltas: [],
      pendingEffects,
    });

    const node = createQuestion('node-created-on-server');
    await awaitQuestionCreation('canvas-restore', node.id);
    await vi.advanceTimersByTimeAsync(500);

    expect(putNodeContent).not.toHaveBeenCalled();
  });

  it('rolls back an unsupported conversation fork without poisoning unrelated saves or undo', async () => {
    const error = new Error('Fork not supported (501)');
    forkThread.mockRejectedValue(error);
    const server = createFakeSpaceServer();
    postCanvasExecute.mockImplementation(async (canvasId, request) =>
      server.execute(canvasId, request),
    );
    useCanvasStore.getState().pasteNodes({ x: 0, y: 0 }, [question]);
    const pasted = useCanvasStore.getState().nodes[0];
    expect(pasted).toBeDefined();
    useCanvasStore.getState().addNode({
      nodeType: 'note',
      placementPoint: { x: 100, y: 100 },
      data: { content: 'Unrelated' },
    });
    await expect(
      awaitQuestionCreation('canvas-restore', pasted.id),
    ).rejects.toThrow('501');
    expect(useCanvasStore.getState().nodes.map((node) => node.type)).toEqual([
      'note',
    ]);
    // The failed fork never sends its Question; the unrelated note behind
    // it in the queue is sent on its own.
    expect(postCanvasExecute).toHaveBeenCalledTimes(1);
    expect(
      postCanvasExecute.mock.calls[0][1].commands.flatMap(
        (command: { nodes?: Array<{ nodeType: string }> }) =>
          (command.nodes ?? []).map((node) => node.nodeType),
      ),
    ).toEqual(['note']);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.state.nodes.map((node) => node.type)).toEqual(['note']);
    await useCanvasStore.getState().undo();
    await useCanvasStore.getState().redo();
    expect(
      useCanvasStore.getState().nodes.some((node) => node.type === 'question'),
    ).toBe(false);
    expect(associateNode).not.toHaveBeenCalled();
    expect(putCanvas).not.toHaveBeenCalled();
  });

  it.each(['http-first', 'sse-first'] as const)(
    'keeps an undone pending creation removed with %s acknowledgement',
    async (order) => {
      let acknowledge!: (response: unknown) => void;
      postCanvasExecute.mockReturnValue(
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
      );
      const node = createQuestion(`node-delayed-${order}`);
      await vi.waitFor(() =>
        expect(postCanvasExecute).toHaveBeenCalledTimes(1),
      );
      await useCanvasStore.getState().undo();
      expect(useCanvasStore.getState().nodes).toEqual([]);
      expect(deleteNode).not.toHaveBeenCalled();
      // The removal is queued behind the creation it undoes.
      expect(postCanvasExecute).toHaveBeenCalledTimes(1);
      const delta = { type: 'INSERT_NODE' as const, node };
      const response = {
        canvasId: 'canvas-restore',
        fromVersion: 1,
        toVersion: 2,
        results: [{ applied: true }],
        deltas: [delta],
        pendingEffects,
      };
      if (order === 'sse-first') {
        useCanvasStore
          .getState()
          .applyDeltasFromAgent([delta], 2, pendingEffects);
        expect(useCanvasStore.getState().nodes).toEqual([]);
        expect(canvasHistoryManager.canUndo).toBe(false);
      }
      acknowledge(response);
      await awaitQuestionCreation('canvas-restore', node.id);
      await vi.waitFor(() =>
        expect(postCanvasExecute).toHaveBeenCalledTimes(2),
      );
      expect(postCanvasExecute.mock.calls[1][1].commands).toEqual([
        { type: 'DELETE_NODES', nodeIds: [node.id] },
      ]);
      await canvasHistoryManager.waitForDeletion('canvas-restore', node.id);
      if (order === 'http-first') {
        useCanvasStore
          .getState()
          .applyDeltasFromAgent([delta], 2, pendingEffects);
      }
      expect(useCanvasStore.getState().nodes).toEqual([]);
      expect(canvasHistoryManager.canUndo).toBe(false);
      expect(deleteNode).toHaveBeenCalledTimes(1);
      expect(deleteNode).toHaveBeenCalledWith('canvas-restore', node.id);
      expect(putCanvas).not.toHaveBeenCalled();
      // A genuinely newer server restoration is not the stale create echo.
      useCanvasStore
        .getState()
        .applyDeltasFromAgent([delta], 5, pendingEffects);
      expect(
        useCanvasStore.getState().nodes.some((item) => item.id === node.id),
      ).toBe(true);
    },
  );

  it('orders explicit deletion after a pending creation too', async () => {
    let acknowledge!: (response: unknown) => void;
    postCanvasExecute.mockReturnValue(
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
    );
    const node = createQuestion('node-delete-pending');
    await vi.waitFor(() => expect(postCanvasExecute).toHaveBeenCalledTimes(1));
    useCanvasStore.getState().deleteNodes([node.id]);
    expect(useCanvasStore.getState().nodes).toEqual([]);
    expect(deleteNode).not.toHaveBeenCalled();
    acknowledge({
      canvasId: 'canvas-restore',
      fromVersion: 1,
      toVersion: 2,
      results: [{ applied: true }],
      deltas: [{ type: 'INSERT_NODE', node }],
      pendingEffects,
    });
    await awaitQuestionCreation('canvas-restore', node.id);
    await canvasHistoryManager.waitForDeletion('canvas-restore', node.id);
    expect(useCanvasStore.getState().nodes).toEqual([]);
    expect(deleteNode).toHaveBeenCalledTimes(1);
  });

  it('can redo while the creation and its compensating deletion are still on their way', async () => {
    let acknowledge!: (response: unknown) => void;
    postCanvasExecute.mockReturnValue(
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
    );
    const node = createQuestion('node-pending-redo');
    await vi.waitFor(() => expect(postCanvasExecute).toHaveBeenCalledTimes(1));
    await useCanvasStore.getState().undo();
    associateNode.mockResolvedValue({ node, fromVersion: 2, toVersion: 3 });
    await useCanvasStore.getState().redo();
    expect(associateNode).not.toHaveBeenCalled();
    acknowledge({
      canvasId: 'canvas-restore',
      fromVersion: 1,
      toVersion: 2,
      results: [{ applied: true }],
      deltas: [{ type: 'INSERT_NODE', node }],
      pendingEffects,
    });
    await awaitQuestionCreation('canvas-restore', node.id);
    expect(deleteNode).toHaveBeenCalledTimes(1);
    expect(associateNode).toHaveBeenCalledTimes(1);
    expect(deleteNode.mock.invocationCallOrder[0]).toBeLessThan(
      associateNode.mock.invocationCallOrder[0],
    );
    expect(useCanvasStore.getState().nodes[0].data.threadId).toBe(
      node.data.threadId,
    );
    expect(putCanvas).not.toHaveBeenCalled();
  });

  it('does not resurrect a pending undo reinsertion removed by redo', async () => {
    const node = { ...question, id: 'node-delayed-restore' };
    canvasHistoryManager.takeSnapshot([node], []);
    let acknowledge!: (response: unknown) => void;
    associateNode.mockReturnValue(
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
    );
    await useCanvasStore.getState().undo();
    await vi.waitFor(() => expect(associateNode).toHaveBeenCalledTimes(1));
    await useCanvasStore.getState().redo();
    expect(deleteNode).not.toHaveBeenCalled();
    const delta = { type: 'INSERT_NODE' as const, node };
    useCanvasStore.getState().applyDeltasFromAgent([delta], 2, pendingEffects);
    acknowledge({ node, fromVersion: 1, toVersion: 2 });
    await awaitQuestionCreation('canvas-restore', node.id);
    await canvasHistoryManager.waitForDeletion('canvas-restore', node.id);
    expect(useCanvasStore.getState().nodes).toEqual([]);
    expect(deleteNode).toHaveBeenCalledTimes(1);
  });

  it('preserves the PDF cover-clear helper and ordinary editable undo', async () => {
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [
        {
          id: 'node-pdf',
          type: 'pdf',
          position: { x: 0, y: 0 },
          data: { coverUrl: 'old-cover', label: 'PDF' },
        },
      ],
    });
    useCanvasStore
      .getState()
      .updateNodeData('node-pdf', { coverUrl: undefined });
    expect(useCanvasStore.getState().nodes[0].data.coverUrl).toBeUndefined();
    expect(useCanvasStore.getState().nodes[0].data.label).toBe('PDF');
    // The clear has been saved; the undo that sets the cover again is sent
    // as a command, so the server needs the node it applies to.
    const server = createFakeSpaceServer();
    server.reset(useCanvasStore.getState().nodes, [], 1);
    postCanvasExecute.mockImplementation(async (canvasId, request) =>
      server.execute(canvasId, request),
    );
    await useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().nodes[0].data.coverUrl).toBe('old-cover');
    await useCanvasStore.getState().redo();
    expect(useCanvasStore.getState().nodes[0].data.coverUrl).toBeUndefined();
  });
});

describe('Question undo identity reinsertion', () => {
  it('restores the UI immediately but waits for the batch that restores its Frame before association', async () => {
    const frame: Node = {
      id: 'node-restore-frame',
      type: 'frame',
      position: { x: 0, y: 0 },
      style: { width: 600, height: 400 },
      data: { type: 'frame', label: 'Frame', sizing: 'manual' },
    };
    const inside = { ...question, parentId: frame.id };
    let answerRestore!: (response: unknown) => void;
    postCanvasExecute.mockReturnValueOnce(
      new Promise((resolve) => {
        answerRestore = resolve;
      }),
    );
    canvasHistoryManager.takeSnapshot([frame, inside], []);
    associateNode.mockResolvedValue({
      node: inside,
      fromVersion: 2,
      toVersion: 3,
    });

    await useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().nodes.map((node) => node.id)).toEqual([
      frame.id,
      question.id,
    ]);
    await vi.waitFor(() => expect(postCanvasExecute).toHaveBeenCalledTimes(1));
    // The Frame comes back with a command; the Agent Node is not in it.
    expect(postCanvasExecute.mock.calls[0][1].commands).toEqual([
      {
        type: 'RESTORE_NODES',
        nodes: [expect.objectContaining({ id: frame.id })],
      },
    ]);
    expect(associateNode).not.toHaveBeenCalled();

    answerRestore({
      canvasId: 'canvas-restore',
      fromVersion: 1,
      toVersion: 2,
      results: [{ applied: true }],
      deltas: [{ type: 'INSERT_NODE', node: frame }],
      pendingEffects,
    });
    await awaitQuestionCreation('canvas-restore', question.id);
    expect(associateNode).toHaveBeenCalledTimes(1);
    expect(useCanvasStore.getState().version).toBe(3);
    expect(putCanvas).not.toHaveBeenCalled();
  });

  it('awaits deletion and validates the old thread before autosave, without replaying old FSM', async () => {
    let finishDelete!: () => void;
    deleteNode.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishDelete = resolve;
      }),
    );
    canvasHistoryManager.trackDelete('canvas-restore', question.id);
    canvasHistoryManager.takeSnapshot([question], []);
    const confirmed = {
      ...question,
      data: {
        content: 'Original intent',
        threadId: 'thread-restore',
        bindingState: 'bound',
        agentBinding: { kind: 'internal' },
      },
    };
    associateNode.mockResolvedValue({
      node: confirmed,
      fromVersion: 1,
      toVersion: 2,
    });
    await useCanvasStore.getState().undo();
    expect(associateNode).not.toHaveBeenCalled();
    finishDelete();
    await awaitQuestionCreation('canvas-restore', question.id);
    expect(associateNode).toHaveBeenCalledWith('canvas-restore', question.id, {
      kind: 'restore',
      node: {
        ...question,
        data: {
          content: 'Original intent',
          agentBinding: { kind: 'internal' },
        },
      },
      threadId: 'thread-restore',
      requireBinding: true,
    });
    const restored = useCanvasStore.getState().nodes[0];
    expect(restored.data.threadId).toBe('thread-restore');
    expect(restored.data.bindingState).toBe('bound');
    expect(restored.data).not.toHaveProperty('invocationToken');
    expect(restored.data).not.toHaveProperty('status');
    expect(useCanvasStore.getState().version).toBe(2);
  });

  it('does not invent a replacement identity after a failed restore', async () => {
    canvasHistoryManager.takeSnapshot([question], []);
    associateNode.mockRejectedValue(new Error('Canonical record is missing'));
    await useCanvasStore.getState().undo();
    await expect(
      awaitQuestionCreation('canvas-restore', question.id),
    ).rejects.toThrow('Canonical record is missing');
    expect(useCanvasStore.getState().nodes).toEqual([]);
    // Nothing else creates the node on the server in its place.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(postCanvasExecute).not.toHaveBeenCalled();
    expect(putCanvas).not.toHaveBeenCalled();
  });
});
