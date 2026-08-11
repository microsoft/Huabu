// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { deleteNode, putNodeContent } from '@/api/canvas';

import { createNodeContentQueue } from '../nodeContentQueue';

import type { CanvasCommitEvent } from '@huabu/shared';
import type { Node } from '@xyflow/react';

vi.mock('@huabu/shared/canvas-engine', () => ({
  nodeRevisionOf: vi.fn(() => 'computed-rev'),
}));

vi.mock('@/api/canvas', () => {
  class CanvasConflictError extends Error {
    code = 'TEST_CONFLICT';
  }
  class NodeDuplicateFilesError extends Error {
    duplicateFiles: string[] = [];
  }
  return {
    CanvasConflictError,
    NodeDuplicateFilesError,
    deleteNode: vi.fn(),
    getNodeContent: vi.fn(),
    putNodeContent: vi.fn(),
  };
});

vi.mock('@/components/Common/Toast', () => ({ toast: vi.fn() }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/utils/io/clipboard', () => ({ copyToClipboard: vi.fn() }));

const putMock = putNodeContent as unknown as Mock;
const deleteMock = deleteNode as unknown as Mock;

function noteNode(content: string, label = 'Note'): Node {
  return {
    id: 'node-new',
    type: 'note',
    position: { x: 10, y: 20 },
    data: { content, label, labelSource: 'auto' },
  } as Node;
}

function createCommit(
  projection: CanvasCommitEvent['nodeChanges'][number] & {
    kind: 'inline';
  },
): CanvasCommitEvent {
  return {
    commitId: 'commit-create',
    fromVersion: 2,
    toVersion: 3,
    structureRevision: 'structure-3',
    originator: { source: 'ui', tabId: 'tab-test' },
    optimistic: true,
    recordChanged: true,
    structureDeltas: [{ type: 'INSERT_NODE' }],
    nodeChanges: [projection],
  };
}

function inlineCreate(
  content: string,
  label: string,
  rev = 'server-rev-1',
): CanvasCommitEvent['nodeChanges'][number] & { kind: 'inline' } {
  return {
    kind: 'inline',
    nodeId: 'node-new',
    recordRevision: 'record-rev-1',
    projection: {
      type: 'note',
      label,
      labelSource: 'auto',
      content,
      rev,
    },
  };
}

function makeQueue() {
  const state = {
    canvasId: 'canvas-1',
    nodes: [] as Node[],
    _setStateNoAutosave: (partial: { nodes: Node[] }) => {
      state.nodes = partial.nodes;
    },
    patchNodeSilent: vi.fn(),
  };
  const queue = createNodeContentQueue({
    delayMs: 10_000,
    getState: () => state,
  });
  return { queue, state };
}

beforeEach(() => {
  putMock.mockReset();
  deleteMock.mockReset();
});

describe('nodeContentQueue aggregate create lifecycle', () => {
  it('holds the initial sidecar until create ACK and adopts its exact revision', async () => {
    const { queue, state } = makeQueue();
    const created = noteNode('initial');
    state.nodes = [created];
    queue.scheduleChanges('canvas-1', [], state.nodes);

    expect(queue.pendingNodeIds()).toEqual(['node-new']);
    await queue.flushNow('canvas-1', 'node-new');
    expect(putMock).not.toHaveBeenCalled();

    const attempt = queue.beginAggregateCreateCommit(state.nodes);
    expect(attempt.nodeIds).toEqual(['node-new']);
    await queue.completeAggregateCreateCommit(
      'canvas-1',
      attempt,
      createCommit(inlineCreate('initial', 'Note 2', 'server-created-rev')),
    );

    expect(putMock).not.toHaveBeenCalled();
    expect(state.nodes[0]?.data).toMatchObject({
      content: 'initial',
      label: 'Note 2',
    });

    const before = state.nodes;
    const current = state.nodes[0];
    if (!current) throw new Error('created node missing after ACK');
    state.nodes = [
      {
        ...current,
        data: { ...current.data, content: 'later' },
      },
    ];
    queue.scheduleChanges('canvas-1', before, state.nodes);
    putMock.mockResolvedValueOnce({
      nodeId: 'node-new',
      label: 'Note 2',
      rev: 'server-rev-2',
    });
    await queue.flushNow('canvas-1', 'node-new');

    expect(putMock).toHaveBeenCalledOnce();
    expect(putMock.mock.calls[0][2]).toMatchObject({
      content: 'later',
      expectRev: 'server-created-rev',
    });
  });

  it('flushes an edit made while the aggregate create is in flight', async () => {
    const { queue, state } = makeQueue();
    state.nodes = [noteNode('before')];
    queue.scheduleChanges('canvas-1', [], state.nodes);
    const attempt = queue.beginAggregateCreateCommit(state.nodes);

    const beforeEdit = state.nodes;
    state.nodes = [noteNode('typed during flight')];
    queue.scheduleChanges('canvas-1', beforeEdit, state.nodes);
    expect(putMock).not.toHaveBeenCalled();

    putMock.mockResolvedValueOnce({
      nodeId: 'node-new',
      label: 'Note 2',
      rev: 'server-rev-2',
    });
    await queue.completeAggregateCreateCommit(
      'canvas-1',
      attempt,
      createCommit(inlineCreate('before', 'Note 2', 'server-created-rev')),
    );

    expect(putMock).toHaveBeenCalledOnce();
    expect(putMock.mock.calls[0][2]).toMatchObject({
      content: 'typed during flight',
      label: 'Note 2',
      expectRev: 'server-created-rev',
    });
    expect(state.nodes[0]?.data).toMatchObject({
      content: 'typed during flight',
      label: 'Note 2',
    });
  });

  it('forgets a node deleted before its create ACK', async () => {
    const { queue, state } = makeQueue();
    state.nodes = [noteNode('temporary')];
    queue.scheduleChanges('canvas-1', [], state.nodes);
    const attempt = queue.beginAggregateCreateCommit(state.nodes);

    state.nodes = [];
    queue.forgetNode('node-new');
    deleteMock.mockResolvedValueOnce({ success: true });
    const committed = await queue.completeAggregateCreateCommit(
      'canvas-1',
      attempt,
      createCommit(inlineCreate('temporary', 'Note')),
    );

    expect(committed).toEqual([]);
    expect(queue.pendingNodeIds()).toEqual([]);
    expect(putMock).not.toHaveBeenCalled();
    expect(deleteMock).toHaveBeenCalledWith('canvas-1', 'node-new', {
      originator: expect.objectContaining({ source: 'ui' }),
    });
  });

  it('does not compensate an old create after the same id is recreated', async () => {
    const { queue, state } = makeQueue();
    state.nodes = [noteNode('first')];
    queue.scheduleChanges('canvas-1', [], state.nodes);
    const firstAttempt = queue.beginAggregateCreateCommit(state.nodes);

    state.nodes = [];
    queue.forgetNode('node-new');
    state.nodes = [noteNode('replacement')];
    queue.scheduleChanges('canvas-1', [], state.nodes);

    await queue.completeAggregateCreateCommit(
      'canvas-1',
      firstAttempt,
      createCommit(inlineCreate('first', 'Note')),
    );

    expect(deleteMock).not.toHaveBeenCalled();
    expect(queue.isAggregateCreatePending('node-new')).toBe(true);
    expect(queue.beginAggregateCreateCommit(state.nodes).nodeIds).toEqual([
      'node-new',
    ]);
  });

  it('keeps a newer type conversion when the create ACK returns the old type', async () => {
    const { queue, state } = makeQueue();
    state.nodes = [noteNode('body')];
    queue.scheduleChanges('canvas-1', [], state.nodes);
    const attempt = queue.beginAggregateCreateCommit(state.nodes);

    const currentNode = state.nodes[0];
    if (!currentNode) throw new Error('expected aggregate node');
    state.nodes = [{ ...currentNode, type: 'text' }];
    await queue.completeAggregateCreateCommit(
      'canvas-1',
      attempt,
      createCommit(inlineCreate('body', 'Note')),
    );

    expect(state.nodes[0]?.type).toBe('text');
  });

  it('arms a dirty remotely-deleted node for aggregate recreation', async () => {
    const { queue, state } = makeQueue();
    state.nodes = [noteNode('local draft')];
    queue.seedBaselines(state.nodes);

    expect(queue.markAggregateRecreate('node-new')).toBe(true);
    expect(queue.markAggregateRecreate('node-new')).toBe(false);
    expect(queue.pendingNodeIds()).toContain('node-new');
    expect(queue.beginAggregateCreateCommit(state.nodes).nodeIds).toEqual([
      'node-new',
    ]);
    await queue.flushNow('canvas-1', 'node-new');
    expect(putMock).not.toHaveBeenCalled();
  });
});

describe('nodeContentQueue preserved empty-body recovery', () => {
  it('restores the canonical body and adopts its revision when empty is still current', async () => {
    const { queue, state } = makeQueue();
    state.nodes = [noteNode('persisted body')];
    queue.seedBaselines(state.nodes);

    const beforeEmpty = state.nodes;
    state.nodes = [noteNode('')];
    queue.scheduleChanges('canvas-1', beforeEmpty, state.nodes);
    putMock.mockResolvedValueOnce({
      nodeId: 'node-new',
      label: 'Note',
      contentPreserved: true,
      content: 'persisted body',
      rev: 'preserved-rev',
    });

    await queue.flushNow('canvas-1', 'node-new');

    expect(state.nodes[0]?.data?.['content']).toBe('persisted body');

    const beforeNextEdit = state.nodes;
    state.nodes = [noteNode('next edit')];
    queue.scheduleChanges('canvas-1', beforeNextEdit, state.nodes);
    putMock.mockResolvedValueOnce({
      nodeId: 'node-new',
      label: 'Note',
      rev: 'next-rev',
    });
    await queue.flushNow('canvas-1', 'node-new');

    expect(putMock.mock.calls[1]?.[2]).toMatchObject({
      content: 'next edit',
      expectRev: 'preserved-rev',
    });
  });

  it('does not overwrite an edit made while the refused empty PUT is in flight', async () => {
    const { queue, state } = makeQueue();
    state.nodes = [noteNode('persisted body')];
    queue.seedBaselines(state.nodes);

    const beforeEmpty = state.nodes;
    state.nodes = [noteNode('')];
    queue.scheduleChanges('canvas-1', beforeEmpty, state.nodes);
    let resolvePut: ((response: unknown) => void) | undefined;
    putMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePut = resolve;
      }),
    );

    const firstSave = queue.flushNow('canvas-1', 'node-new');
    await vi.waitFor(() => expect(putMock).toHaveBeenCalledOnce());

    const beforeNewerEdit = state.nodes;
    state.nodes = [noteNode('newer local edit')];
    queue.scheduleChanges('canvas-1', beforeNewerEdit, state.nodes);
    resolvePut?.({
      nodeId: 'node-new',
      label: 'Note',
      contentPreserved: true,
      content: 'persisted body',
      rev: 'preserved-rev',
    });
    await firstSave;

    expect(state.nodes[0]?.data?.['content']).toBe('newer local edit');

    putMock.mockResolvedValueOnce({
      nodeId: 'node-new',
      label: 'Note',
      rev: 'next-rev',
    });
    await queue.flushNow('canvas-1', 'node-new');
    expect(putMock.mock.calls[1]?.[2]).toMatchObject({
      content: 'newer local edit',
      expectRev: 'preserved-rev',
    });
  });

  it('does not overwrite a newer label with an older canonical response', async () => {
    const { queue, state } = makeQueue();
    state.nodes = [noteNode('body', 'First')];
    queue.seedBaselines(state.nodes);
    let resolvePut: ((response: unknown) => void) | undefined;
    putMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePut = resolve;
      }),
    );

    const first = queue.flushNow('canvas-1', 'node-new');
    await vi.waitFor(() => expect(putMock).toHaveBeenCalledOnce());
    const beforeNewerRename = state.nodes;
    const currentNode = state.nodes[0];
    if (!currentNode) throw new Error('expected aggregate node');
    state.nodes = [
      {
        ...currentNode,
        data: {
          ...currentNode.data,
          label: 'Second',
          labelSource: 'user',
        },
      },
    ];
    queue.scheduleChanges('canvas-1', beforeNewerRename, state.nodes);
    resolvePut?.({
      nodeId: 'node-new',
      label: 'First 2',
      rev: 'first-rev',
    });
    await first;

    expect(state.nodes[0]?.data?.['label']).toBe('Second');
    putMock.mockResolvedValueOnce({
      nodeId: 'node-new',
      label: 'Second',
      rev: 'second-rev',
    });
    await queue.flushNow('canvas-1', 'node-new');
    expect(putMock.mock.calls[1]?.[2]).toMatchObject({
      label: 'Second',
      expectRev: 'first-rev',
    });
  });
});
