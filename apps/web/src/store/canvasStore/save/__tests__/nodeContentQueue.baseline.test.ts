// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Baseline (optimistic-concurrency) lifecycle for the per-node content
 * queue. The `expectRev` a write carries must:
 *   1. start from the seeded revision of the loaded content,
 *   2. advance to the server-returned `rev` after each successful write
 *      (so a rapid follow-up edit doesn't 409 against our own write),
 *   3. on a `NODE_CONTENT_CONFLICT`, keep the user's text (no revert),
 *      not retry, and toast at most once per node.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import {
  CanvasConflictError,
  getNodeContent,
  putNodeContent,
} from '@/api/canvas';
import { toast } from '@/components/Common/Toast';
import { holdSaveErrorRecovery } from '@/utils/saveErrorFeedback';

import { createNodeContentQueue } from '../nodeContentQueue';

import type * as CanvasApi from '@/api/canvas';
import type { PutNodeContentRequest } from '@huabu/shared';
import type { Node } from '@xyflow/react';

vi.mock('@/api/canvas', async (importActual) => {
  const actual = await importActual<typeof CanvasApi>();
  return { ...actual, getNodeContent: vi.fn(), putNodeContent: vi.fn() };
});

vi.mock('@/components/Common/Toast', () => ({
  toast: vi.fn(),
}));

const putMock = putNodeContent as unknown as Mock;
const getMock = getNodeContent as unknown as Mock;
const toastMock = toast as unknown as Mock;

function noteNode(content: string, label = 'Note'): Node {
  return {
    id: 'n1',
    type: 'note',
    position: { x: 0, y: 0 },
    data: { content, label },
  } as Node;
}

function questionNode(content: string, label = 'Question 1'): Node {
  return {
    id: 'q1',
    type: 'question',
    position: { x: 0, y: 0 },
    data: { content, label, threadId: 'thread-1' },
  } as Node;
}

function makeQueue(
  node: Node,
  options?: { waitForCreation?: () => Promise<void> },
) {
  const state = {
    canvasId: 'c1',
    isLoading: false,
    nodes: [node] as Node[],
    _setStateNoAutosave: vi.fn(),
    patchNodeSilent: vi.fn(),
  };
  const queue = createNodeContentQueue({
    delayMs: 0,
    getState: () => state,
    waitForCreation: options?.waitForCreation
      ? () => options.waitForCreation!()
      : undefined,
  });
  return { queue, state };
}

beforeEach(() => {
  putMock.mockReset();
  getMock.mockReset();
  toastMock.mockReset();
});

describe('nodeContentQueue baseline lifecycle', () => {
  it('does not send clears for untouched optional metadata on a new node', async () => {
    const node = noteNode('body');
    const { queue } = makeQueue(node);
    putMock.mockResolvedValue({ nodeId: 'n1', label: 'Note', rev: 'saved' });
    queue.scheduleChanges('c1', [], [node]);
    await queue.flushAll();
    const body = putMock.mock.calls[0][2];
    expect(body).not.toHaveProperty('noteContent');
    expect(body).not.toHaveProperty('propertyDisplayKeys');
  });
  it.each<Pick<PutNodeContentRequest, 'properties' | 'propertyDisplayKeys'>>([
    { properties: { Added: 'new' }, propertyDisplayKeys: ['Venue', 'Added'] },
    {
      properties: { Venue: null, Conference: 'UIST' },
      propertyDisplayKeys: ['Conference'],
    },
    { properties: { Venue: null }, propertyDisplayKeys: [] },
  ])(
    'retracts a failed property operation without leaving it queued: %j',
    async (patch) => {
      const node = noteNode('body');
      node.data.properties = { Venue: 'UIST' };
      node.data.propertyDisplayKeys = ['Venue'];
      const { queue, state } = makeQueue(node);
      state._setStateNoAutosave.mockImplementation(({ nodes }) => {
        state.nodes = nodes;
      });
      queue.seedBaselines([node]);
      putMock.mockRejectedValueOnce(new Error('offline'));
      await expect(queue.commitProperties('c1', 'n1', patch)).rejects.toThrow(
        'offline',
      );
      expect(state.nodes[0].data).toEqual(node.data);
      expect(queue.pendingFields('n1').size).toBe(0);
      expect(queue.hasUnsavedContent('c1')).toBe(false);
      queue.retryFailedSaves('c1');
      await queue.flushAll();
      expect(putMock).toHaveBeenCalledTimes(1);
      putMock.mockResolvedValue({ nodeId: 'n1', label: 'Note', rev: 'next' });
      const previous = state.nodes;
      state.nodes = [
        {
          ...previous[0],
          data: { ...previous[0].data, content: 'later body' },
        },
      ];
      queue.scheduleChanges('c1', previous, state.nodes);
      await queue.flushNow('c1', 'n1');
      expect(putMock.mock.calls.at(-1)?.[2].properties).toEqual({
        Venue: 'UIST',
      });
    },
  );

  it('keeps newer properties and unrelated pending content when retracting a failed edit', async () => {
    const node = noteNode('body');
    node.data.properties = { Venue: 'UIST', Score: 1 };
    const { queue, state } = makeQueue(node);
    state._setStateNoAutosave.mockImplementation(({ nodes }) => {
      state.nodes = nodes;
    });
    queue.seedBaselines([node]);
    putMock.mockImplementationOnce(async () => {
      const previous = state.nodes;
      state.nodes = [
        {
          ...previous[0],
          data: {
            ...previous[0].data,
            content: 'new body',
            properties: { Venue: 'Newest', Score: 2, Added: true },
          },
        },
      ];
      queue.scheduleChanges('c1', previous, state.nodes);
      throw new Error('offline');
    });
    await expect(
      queue.commitProperties('c1', 'n1', {
        properties: { Venue: 'DIS', Score: 9 },
      }),
    ).rejects.toThrow('offline');
    expect(state.nodes[0].data).toMatchObject({
      content: 'new body',
      properties: { Venue: 'Newest', Score: 2, Added: true },
    });
    expect(queue.pendingFields('n1')).toEqual(
      new Set(['content', 'properties']),
    );
    putMock.mockResolvedValue({ nodeId: 'n1', label: 'Note', rev: 'next' });
    await queue.flushNow('c1', 'n1');
    expect(queue.pendingFields('n1').size).toBe(0);
  });

  it('captures the rollback state inside the serialized lane after earlier edits settle', async () => {
    const node = noteNode('body');
    node.data.properties = { Venue: 'UIST' };
    const { queue, state } = makeQueue(node);
    state._setStateNoAutosave.mockImplementation(({ nodes }) => {
      state.nodes = nodes;
    });
    queue.seedBaselines([node]);
    putMock.mockResolvedValueOnce({
      nodeId: 'n1',
      label: 'Note',
      rev: 'saved',
    });
    putMock.mockRejectedValueOnce(new Error('offline'));
    const first = queue.commitProperties('c1', 'n1', {
      properties: { Venue: 'CHI' },
    });
    const second = queue.commitProperties('c1', 'n1', {
      properties: { Venue: 'DIS' },
    });
    await first;
    await expect(second).rejects.toThrow('offline');
    expect(state.nodes[0].data.properties).toEqual({ Venue: 'CHI' });
    expect(queue.hasUnsavedContent('c1')).toBe(false);
  });

  it('uses the loaded server revision when PDF content is deliberately omitted', async () => {
    const node: Node = {
      id: 'pdf',
      type: 'pdf',
      position: { x: 0, y: 0 },
      data: {
        label: 'Paper',
        src: 'paper.pdf',
        properties: { Venue: 'CHI 25' },
      },
    };
    const serverRev = nodeRevisionOf({
      ...node.data,
      type: 'pdf',
      content: 'Extracted text only available on the server',
    });
    const { queue, state } = makeQueue(node);
    queue.seedBaselines([node], { pdf: serverRev });
    const edited = {
      ...node,
      data: {
        ...node.data,
        properties: { Venue: 'CHI 25', Status: 'Reading' },
      },
    };
    state.nodes = [edited];
    queue.scheduleChanges('c1', [node], [edited]);
    putMock.mockResolvedValue({ nodeId: 'pdf', label: 'Paper', rev: 'saved' });
    await queue.flushNow('c1', 'pdf');
    expect(putMock.mock.calls[0][2]).toMatchObject({
      expectRev: serverRev,
      properties: edited.data.properties,
    });
    expect(putMock.mock.calls[0][2]).not.toHaveProperty('content');
    expect(toastMock).not.toHaveBeenCalled();
    queue.seedBaselines([edited], { pdf: 'saved' });
    const next = {
      ...edited,
      data: { ...edited.data, properties: { Venue: 'CHI 25', Status: 'Read' } },
    };
    state.nodes = [next];
    queue.scheduleChanges('c1', [edited], [next]);
    await queue.flushNow('c1', 'pdf');
    expect(putMock.mock.calls.at(-1)?.[2].expectRev).toBe('saved');
  });

  it('sends property tombstones from the acknowledged baseline and retains edits made during a save', async () => {
    const node = noteNode('body');
    node.data.properties = { keep: 'yes', remove: 2026 };
    const { queue, state } = makeQueue(node);
    queue.seedBaselines([node]);
    const edited = {
      ...node,
      data: { ...node.data, properties: { keep: 'yes' } },
    };
    state.nodes = [edited];
    queue.scheduleChanges('c1', [node], [edited]);
    let resolve!: (value: unknown) => void;
    putMock.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const saving = queue.flushNow('c1', 'n1');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(putMock).toHaveBeenCalledOnce();
    expect(putMock.mock.calls[0][2]).toMatchObject({
      properties: { keep: 'yes', remove: null },
      expectRev: nodeRevisionOf({
        content: 'body',
        properties: node.data.properties,
      }),
    });
    const next = { ...edited, data: { ...edited.data, properties: {} } };
    state.nodes = [next];
    queue.scheduleChanges('c1', [edited], [next]);
    resolve({ nodeId: 'n1', label: 'Note', rev: 'FIRST' });
    await saving;
    putMock.mockResolvedValue({ nodeId: 'n1', label: 'Note', rev: 'SECOND' });
    await queue.flushNow('c1', 'n1');
    expect(putMock.mock.calls.at(-1)?.[2]).toMatchObject({
      properties: { keep: null },
      expectRev: 'FIRST',
    });
  });
  it('suppresses the redundant Question creation PUT', async () => {
    const node = questionNode('');
    const { queue } = makeQueue(node);

    queue.prepareServerCreatedNodes([node]);
    queue.scheduleChanges('c1', [], [node]);
    await queue.flushAll();

    expect(putMock).not.toHaveBeenCalled();
    expect(queue.pendingNodeIds()).toEqual([]);
  });

  it('waits for Question creation before persisting a real pre-acknowledgement edit', async () => {
    let acknowledge!: () => void;
    const creation = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const node = questionNode('');
    const { queue, state } = makeQueue(node, {
      waitForCreation: () => creation,
    });
    queue.prepareServerCreatedNodes([node]);
    queue.scheduleChanges('c1', [], [node]);
    const edited = questionNode('First prompt');
    state.nodes = [edited];
    queue.scheduleChanges('c1', [node], [edited]);
    putMock.mockResolvedValue({
      nodeId: 'q1',
      label: 'Question 1',
      rev: 'FIRST',
    });

    const flushing = queue.flushAll();
    await Promise.resolve();
    expect(putMock).not.toHaveBeenCalled();
    acknowledge();
    await flushing;

    expect(putMock).toHaveBeenCalledOnce();
    expect(putMock.mock.calls[0][2]).toMatchObject({
      content: 'First prompt',
      expectRev: nodeRevisionOf({ content: '' }),
    });
  });

  it('sends only locally dirty Question fields', async () => {
    const node = questionNode('');
    const { queue, state } = makeQueue(node);
    queue.seedBaselines([node]);
    const edited = questionNode('Pending prompt');
    state.nodes = [edited];
    queue.scheduleChanges('c1', [node], [edited]);
    putMock.mockResolvedValue({
      nodeId: 'q1',
      label: 'Generated remotely',
      rev: 'BODY',
    });

    await queue.flushAll();

    expect(putMock.mock.calls[0][2]).toEqual({
      nodeType: 'question',
      content: 'Pending prompt',
      expectRev: nodeRevisionOf({ content: '' }),
    });
  });

  it('ignores an obsolete success after a newer authoritative baseline and retries', async () => {
    let finishFirst!: (value: unknown) => void;
    const first = new Promise((resolve) => {
      finishFirst = resolve;
    });
    const node = questionNode('');
    const { queue, state } = makeQueue(node);
    queue.seedBaselines([node]);
    const edited = questionNode('Mine');
    state.nodes = [edited];
    queue.scheduleChanges('c1', [node], [edited]);
    putMock
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ nodeId: 'q1', label: 'Remote', rev: 'MINE' });

    const flushing = queue.flushAll();
    await vi.waitFor(() => expect(putMock).toHaveBeenCalledOnce());
    queue.seedBaselines([questionNode('Remote prompt', 'Remote')]);
    finishFirst({ nodeId: 'q1', label: 'Question 1', rev: 'OLD' });
    await flushing;
    await queue.flushAll();

    expect(putMock).toHaveBeenCalledTimes(2);
    expect(putMock.mock.calls[1][2].expectRev).toBe(
      nodeRevisionOf({ content: 'Remote prompt' }),
    );
    expect(state._setStateNoAutosave).toHaveBeenCalledWith({
      nodes: [
        expect.objectContaining({
          data: expect.objectContaining({ label: 'Remote' }),
        }),
      ],
    });
  });

  it('does not surface an obsolete conflict after a newer authoritative baseline', async () => {
    let failFirst!: (error: unknown) => void;
    const first = new Promise((_resolve, reject) => {
      failFirst = reject;
    });
    const node = questionNode('');
    const { queue, state } = makeQueue(node);
    queue.seedBaselines([node]);
    const edited = questionNode('Mine');
    state.nodes = [edited];
    queue.scheduleChanges('c1', [node], [edited]);
    putMock
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ nodeId: 'q1', label: 'Remote', rev: 'MINE' });

    const flushing = queue.flushAll();
    await vi.waitFor(() => expect(putMock).toHaveBeenCalledOnce());
    queue.seedBaselines([questionNode('Remote prompt', 'Remote')]);
    failFirst(
      new CanvasConflictError({
        code: 'NODE_CONTENT_CONFLICT',
        message: 'changed elsewhere',
        nodeId: 'q1',
        currentRev: 'REMOTE',
      }),
    );
    await flushing;
    await queue.flushAll();

    expect(toastMock).not.toHaveBeenCalled();
    expect(putMock).toHaveBeenCalledTimes(2);
  });

  it('forgetting a removed restore clears both barriers before an obsolete acknowledgement', async () => {
    const node = noteNode('restored');
    const { queue, state } = makeQueue(node);
    queue.holdRestoredNodes('c1', [node]);
    const tokens = queue.restoreTokens();
    expect(queue.hasRestore(node.id)).toBe(true);
    expect(queue.hasPendingRestoredContent()).toBe(true);

    // The store deletion diff forgets the node synchronously on rapid redo.
    state.nodes = [];
    queue.forgetNode(node.id);
    queue.acknowledgeRestores('c1', tokens);

    expect(queue.hasRestore(node.id)).toBe(false);
    expect(queue.hasPendingRestoredContent()).toBe(false);
    expect(queue.restoreTokens().size).toBe(0);
    expect(queue.pendingNodeIds()).toEqual([]);
    await queue.waitForIdle();
    await queue.flushAll();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('sends the seeded rev, then advances to the server-returned rev', async () => {
    const node = noteNode('v1');
    const { queue } = makeQueue(node);
    queue.seedBaselines([node]);

    putMock.mockResolvedValueOnce({ nodeId: 'n1', label: 'Note', rev: 'SRV1' });
    await queue.flushNow('c1', 'n1');

    expect(putMock).toHaveBeenCalledTimes(1);
    expect(putMock.mock.calls[0][2].expectRev).toBe(
      nodeRevisionOf({ content: 'v1' }),
    );

    // Second write carries the server-returned rev, not a self-recompute.
    putMock.mockResolvedValueOnce({ nodeId: 'n1', label: 'Note', rev: 'SRV2' });
    await queue.flushNow('c1', 'n1');
    expect(putMock.mock.calls[1][2].expectRev).toBe('SRV1');
  });

  it('sends the empty-content rev for a node with no seeded baseline', async () => {
    const node = noteNode('fresh');
    const { queue } = makeQueue(node);
    // No seedBaselines() — brand-new node created this session.

    putMock.mockResolvedValueOnce({ nodeId: 'n1', label: 'Note', rev: 'SRV1' });
    await queue.flushNow('c1', 'n1');

    expect(putMock.mock.calls[0][2].expectRev).toBe(nodeRevisionOf({}));
  });

  it('does not recreate a missing markdown sidecar', async () => {
    const node = noteNode('');
    node.data = { ...node.data, contentMissing: true };
    const { queue } = makeQueue(node);

    await queue.flushNow('c1', 'n1');

    expect(putMock).not.toHaveBeenCalled();
  });

  it('on NODE_CONTENT_CONFLICT: no throw, keeps text, freezes, toasts once', async () => {
    const node = noteNode('v1');
    const { queue, state } = makeQueue(node);
    queue.seedBaselines([node]);

    const conflict = new CanvasConflictError({
      code: 'NODE_CONTENT_CONFLICT',
      message: 'changed elsewhere',
      nodeId: 'n1',
      currentRev: 'OTHER',
    });
    putMock.mockRejectedValue(conflict);

    // Must not reject (fire-and-forget autosave path).
    await expect(queue.flushNow('c1', 'n1')).resolves.toBeUndefined();
    // User's text is never reverted on a content conflict.
    expect(state._setStateNoAutosave).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(putMock).toHaveBeenCalledTimes(1);

    // The node is now frozen: a subsequent flush (autosave / keepalive)
    // must NOT issue another PUT — nothing can clobber the newer server
    // content while the conflict is unresolved.
    await queue.flushNow('c1', 'n1');
    expect(putMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'adopts contentMissing when Load latest finds a deleted sidecar (deferred: %s)',
    async (deferred) => {
      const node = noteNode('mine');
      const { queue, state } = makeQueue(node);
      queue.seedBaselines([node]);
      putMock.mockRejectedValueOnce(
        new CanvasConflictError({
          code: 'NODE_CONTENT_CONFLICT',
          message: 'changed elsewhere',
          nodeId: 'n1',
          currentRev: 'OTHER',
        }),
      );
      getMock.mockResolvedValueOnce({
        nodeId: 'n1',
        type: 'note',
        label: null,
        content: '',
        rev: nodeRevisionOf({}),
        contentMissing: true,
      });

      const release = deferred ? holdSaveErrorRecovery() : undefined;
      try {
        await queue.flushNow('c1', 'n1');
        if (deferred) expect(toastMock).not.toHaveBeenCalled();
      } finally {
        release?.();
      }
      const toastOpts = toastMock.mock.calls[0][1] as {
        action: { onClick: () => void };
      };
      toastOpts.action.onClick();
      await vi.waitFor(() => {
        expect(state._setStateNoAutosave).toHaveBeenCalledWith({
          nodes: [
            expect.objectContaining({
              data: expect.objectContaining({ contentMissing: true }),
            }),
          ],
        });
      });
    },
  );

  it('"Keep mine" re-baselines to the disk rev and force-writes over it', async () => {
    const node = noteNode('mine');
    const { queue } = makeQueue(node);
    queue.seedBaselines([node]);

    const conflict = new CanvasConflictError({
      code: 'NODE_CONTENT_CONFLICT',
      message: 'changed elsewhere',
      nodeId: 'n1',
      currentRev: 'DISK_REV',
    });
    putMock.mockRejectedValueOnce(conflict);
    await queue.flushNow('c1', 'n1');

    // Grab the "Keep mine" action from the toast and invoke it.
    const toastOpts = toastMock.mock.calls[0][1] as {
      secondaryAction: { onClick: () => void };
    };
    putMock.mockResolvedValueOnce({ nodeId: 'n1', label: 'Note', rev: 'SRV9' });
    toastOpts.secondaryAction.onClick();
    await vi.waitFor(() => expect(putMock).toHaveBeenCalledTimes(2));

    // The forced write carries the disk rev we collided with, so it
    // deliberately overwrites the other change.
    const forced = putMock.mock.calls[1][2];
    expect(forced.expectRev).toBe('DISK_REV');
  });
});
