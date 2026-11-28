// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

const { associateNode, putNodeContent, postCanvasExecute, forkThread } =
  vi.hoisted(() => ({
    associateNode: vi.fn(),
    putNodeContent: vi.fn(),
    postCanvasExecute: vi.fn(),
    forkThread: vi.fn(),
  }));
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof CanvasApi>()),
  associateAgentNode: associateNode,
  postCanvasExecute,
  postCanvasEvents: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('../api/canvas', async (importOriginal) => ({
  ...(await importOriginal<typeof CanvasApi>()),
  putNodeContent,
}));
vi.mock('../api/agent', () => ({ agentApi: { forkThread } }));

import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore, {
  awaitQuestionCreation,
  resetCanvasSyncForTests,
} from './canvasStore';
import { contentRevisionsOf } from './canvasStore/sync/testing/contentRevisions';
import {
  createFakeSpaceServer,
  seedStoredNodes,
} from './canvasStore/sync/testing/fakeExecuteServer';

import type * as CanvasApi from '../api';
import type {
  PostCanvasExecuteRequest,
  PutNodeContentRequest,
} from '@huabu/shared';
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
  useCanvasStore.getState()._setStateRaw({
    canvasId: 'canvas-restore',
    nodes: [],
    edges: [],
    version: 1,
    isLoading: false,
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** The commands of this page's `index`-th request, edit by edit. */
function sentBatches(index: number): unknown[][] {
  const request = postCanvasExecute.mock.calls[
    index
  ][1] as PostCanvasExecuteRequest;
  return request.edits.map((edit) => edit.commands);
}
/** The commands of this page's `index`-th request, in order. */
const sentCommands = (index: number): unknown[] => sentBatches(index).flat();

/** Node ids this page asked the server to delete (through `execute`). */
function sentDeletions(): string[] {
  return postCanvasExecute.mock.calls.flatMap(([, request]) =>
    (
      (request as PostCanvasExecuteRequest).edits.flatMap(
        (edit) => edit.commands,
      ) as Array<{ type: string; nodeIds?: string[] }>
    ).flatMap((command) =>
      command.type === 'DELETE_NODES' ? (command.nodeIds ?? []) : [],
    ),
  );
}

const pendingEffects = {
  mutatedNodeIds: [],
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
      edits: [{ applied: true, results: [{ applied: true }] }],
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
      sentCommands(0).flatMap((command) =>
        ((command as { nodes?: Array<{ nodeType: string }> }).nodes ?? []).map(
          (node) => node.nodeType,
        ),
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
      expect(sentDeletions()).toEqual([]);
      // The removal is queued behind the creation it undoes.
      expect(postCanvasExecute).toHaveBeenCalledTimes(1);
      const delta = { type: 'INSERT_NODE' as const, node };
      const response = {
        canvasId: 'canvas-restore',
        fromVersion: 1,
        toVersion: 2,
        edits: [{ applied: true, results: [{ applied: true }] }],
        deltas: [delta],
        pendingEffects,
      };
      if (order === 'sse-first') {
        useCanvasStore.getState().applyServerDeltas([delta], 2, pendingEffects);
        expect(useCanvasStore.getState().nodes).toEqual([]);
        expect(canvasHistoryManager.canUndo).toBe(false);
      }
      acknowledge(response);
      await awaitQuestionCreation('canvas-restore', node.id);
      await vi.waitFor(() =>
        expect(postCanvasExecute).toHaveBeenCalledTimes(2),
      );
      expect(sentBatches(1)).toEqual([
        [{ type: 'DELETE_NODES', nodeIds: [node.id] }],
      ]);
      await vi.advanceTimersByTimeAsync(0);
      if (order === 'http-first') {
        useCanvasStore.getState().applyServerDeltas([delta], 2, pendingEffects);
      }
      expect(useCanvasStore.getState().nodes).toEqual([]);
      expect(canvasHistoryManager.canUndo).toBe(false);
      // The record leaves the server with that batch, and with nothing else.
      expect(sentDeletions()).toEqual([node.id]);
      // A genuinely newer server restoration is not the stale create echo.
      useCanvasStore
        .getState()
        .applyServerDeltas([delta], 5, pendingEffects, false, {
          nodeContentRevisions: contentRevisionsOf([delta]),
        });
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
    expect(sentDeletions()).toEqual([]);
    acknowledge({
      canvasId: 'canvas-restore',
      fromVersion: 1,
      toVersion: 2,
      edits: [{ applied: true, results: [{ applied: true }] }],
      deltas: [{ type: 'INSERT_NODE', node }],
      pendingEffects,
    });
    await awaitQuestionCreation('canvas-restore', node.id);
    await vi.waitFor(() => expect(sentDeletions()).toEqual([node.id]));
    expect(useCanvasStore.getState().nodes).toEqual([]);
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
      edits: [{ applied: true, results: [{ applied: true }] }],
      deltas: [{ type: 'INSERT_NODE', node }],
      pendingEffects,
    });
    await awaitQuestionCreation('canvas-restore', node.id);
    await vi.waitFor(() => expect(associateNode).toHaveBeenCalledTimes(1));
    // The removal was sent, as the second batch, before the node was
    // associated again.
    expect(sentDeletions()).toEqual([node.id]);
    expect(postCanvasExecute.mock.invocationCallOrder[1]).toBeLessThan(
      associateNode.mock.invocationCallOrder[0],
    );
    expect(useCanvasStore.getState().nodes[0].data.threadId).toBe(
      node.data.threadId,
    );
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
    const delta = { type: 'INSERT_NODE' as const, node };
    useCanvasStore.getState().applyServerDeltas([delta], 2, pendingEffects);
    acknowledge({ node, fromVersion: 1, toVersion: 2 });
    await awaitQuestionCreation('canvas-restore', node.id);
    await vi.waitFor(() => expect(sentDeletions()).toEqual([node.id]));
    expect(useCanvasStore.getState().nodes).toEqual([]);
  });

  it('preserves the PDF cover-clear helper and ordinary editable undo', async () => {
    useCanvasStore.getState()._setStateRaw({
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
    // The snapshot holds nodes as the page had them: keyed.
    const [frame, inside] = seedStoredNodes<Node>([
      {
        id: 'node-restore-frame',
        type: 'frame',
        position: { x: 0, y: 0 },
        style: { width: 600, height: 400 },
        data: { type: 'frame', label: 'Frame', sizing: 'manual' },
      },
      { ...question, parentId: 'node-restore-frame' },
    ]);
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
    expect(sentBatches(0)).toEqual([
      [
        {
          type: 'RESTORE_NODES',
          nodes: [expect.objectContaining({ id: frame.id })],
        },
      ],
    ]);
    expect(associateNode).not.toHaveBeenCalled();

    answerRestore({
      canvasId: 'canvas-restore',
      fromVersion: 1,
      toVersion: 2,
      edits: [{ applied: true, results: [{ applied: true }] }],
      deltas: [{ type: 'INSERT_NODE', node: frame }],
      pendingEffects,
    });
    await awaitQuestionCreation('canvas-restore', question.id);
    expect(associateNode).toHaveBeenCalledTimes(1);
    expect(useCanvasStore.getState().version).toBe(3);
  });

  it('awaits deletion and validates the old thread before autosave, without replaying old FSM', async () => {
    // The batch that removed the node is still on its way to the server.
    let finishDelete!: () => void;
    postCanvasExecute.mockReturnValueOnce(
      new Promise((resolve) => {
        finishDelete = () =>
          resolve({
            canvasId: 'canvas-restore',
            fromVersion: 1,
            toVersion: 1,
            edits: [
              { applied: true, results: [{ applied: false, reason: 'no-op' }] },
            ],
            deltas: [],
            pendingEffects,
          });
      }),
    );
    // As loaded from the server: the node has its paint key.
    const [loaded] = seedStoredNodes([question]);
    const { paintKey } = loaded.data;
    useCanvasStore.getState()._setStateRaw({ nodes: [loaded] });
    useCanvasStore.getState().deleteNodes([question.id]);
    await vi.waitFor(() => expect(sentDeletions()).toEqual([question.id]));
    const confirmed = {
      ...question,
      data: {
        paintKey,
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
          // The node asks for its old place in the paint order back.
          paintKey,
        },
      },
      threadId: 'thread-restore',
      requireBinding: true,
    });
    const restored = useCanvasStore.getState().nodes[0];
    expect(restored.data.paintKey).toBe(paintKey);
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
  });
});
