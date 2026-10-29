// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Save-failure surfacing for the per-node content queue (P0.5).
 *
 * A genuine (non-conflict) write failure — a 500 / IO / Drive-lock where the
 * body AND any rename silently didn't land — must be surfaced, even for
 * background (`auto`) saves, so the user isn't left unaware their edit wasn't
 * persisted. It shows a retryable toast, throttled to once per node on the
 * `auto` path until a save succeeds. A `NODE_CONTENT_CONFLICT` (409) is a
 * benign race handled elsewhere and is covered by the baseline suite.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  CanvasConflictError,
  NodeDuplicateFilesError,
  putNodeContent,
} from '@/api/canvas';
import { dismissToast, toast } from '@/components/Common/Toast';

import { createNodeContentQueue } from '../nodeContentQueue';

import type * as CanvasApi from '@/api/canvas';
import type { Node } from '@xyflow/react';

vi.mock('@/api/canvas', async (importActual) => {
  const actual = await importActual<typeof CanvasApi>();
  return { ...actual, putNodeContent: vi.fn() };
});

vi.mock('@/components/Common/Toast', () => ({
  toast: vi.fn(),
  dismissToast: vi.fn(),
}));

const putMock = putNodeContent as unknown as Mock;
const toastMock = toast as unknown as Mock;

function noteNode(content: string, label = 'Note'): Node {
  return {
    id: 'n1',
    type: 'note',
    position: { x: 0, y: 0 },
    data: { content, label },
  } as Node;
}

function makeQueue(node: Node) {
  const state = {
    canvasId: 'c1',
    isLoading: false,
    nodes: [node] as Node[],
    _setStateNoAutosave: vi.fn(),
    patchNodeSilent: vi.fn(),
  };
  const queue = createNodeContentQueue({ delayMs: 0, getState: () => state });
  return { queue, state };
}

/** Await a macrotask so a fire-and-forget retry flush can settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  putMock.mockReset();
  toastMock.mockReset();
});

describe('nodeContentQueue — save-failure surfacing', () => {
  it('keeps failure records while suspended and permits retry after resuming', async () => {
    const node = noteNode('v1');
    const { queue } = makeQueue(node);
    putMock.mockRejectedValue(new Error('offline'));
    await expect(queue.flushNow('c1', node.id)).rejects.toThrow('offline');
    const resume = queue.suspendCanvas('c1');
    putMock.mockResolvedValue({ nodeId: node.id, label: 'Note', rev: 'saved' });
    queue.retryFailedSaves('c1');
    await queue.flushNow('c1', node.id);
    await expect(queue.flushAllForSubmission('c1')).rejects.toThrow(
      'Content saves failed',
    );
    expect(putMock).toHaveBeenCalledOnce();
    resume();
    queue.retryFailedSaves('c1');
    await queue.flushAllForSubmission('c1');
    expect(putMock).toHaveBeenCalledTimes(2);
  });

  it('does not issue a queued PUT after its creation dependency settles during suspension', async () => {
    const node = noteNode('v1');
    const { state } = makeQueue(node);
    let resolve!: () => void;
    const creation = new Promise<void>((done) => {
      resolve = done;
    });
    const waitForCreation = vi.fn(() => creation);
    const queue = createNodeContentQueue({
      delayMs: 0,
      getState: () => state,
      waitForCreation,
    });
    const saving = queue.flushNow('c1', node.id);
    await tick();
    expect(waitForCreation).toHaveBeenCalledOnce();
    const resume = queue.suspendCanvas('c1');
    resolve();
    await saving;
    expect(putMock).not.toHaveBeenCalled();
    resume();
    putMock.mockResolvedValue({ nodeId: node.id, label: 'Note', rev: 'saved' });
    await queue.flushNow('c1', node.id);
    expect(putMock).toHaveBeenCalledOnce();
  });

  it('does not start a rebased retry after an issued PUT settles during suspension', async () => {
    const node = noteNode('v1');
    const { queue } = makeQueue(node);
    let reject!: (error: Error) => void;
    putMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const saving = queue.flushNow('c1', node.id);
    await tick();
    expect(putMock).toHaveBeenCalledOnce();
    queue.seedBaselines([noteNode('server revision')]);
    const resume = queue.suspendCanvas('c1');
    reject(
      new CanvasConflictError({
        code: 'NODE_CONTENT_CONFLICT',
        message: 'revision advanced',
        currentRev: 'server',
      }),
    );
    await saving;
    expect(putMock).toHaveBeenCalledOnce();
    resume();
  });

  it.each([
    new Error('offline'),
    new NodeDuplicateFilesError({
      message: 'duplicate files',
      duplicateFiles: ['a.md', 'b.md'],
    }),
  ])(
    're-alerts after an authoritative baseline retires the previous failure: %s',
    async (failure) => {
      const node = noteNode('v1');
      const { queue } = makeQueue(node);
      toastMock.mockReturnValue('failed-save');
      queue.seedBaselines([node]);
      putMock.mockRejectedValue(failure);
      await expect(
        queue.flushNow('c1', node.id, { source: 'auto' }),
      ).rejects.toBe(failure);
      expect(toastMock).toHaveBeenCalledOnce();
      queue.seedBaselines([node]);
      expect(dismissToast).toHaveBeenCalledWith('failed-save');
      await expect(
        queue.flushNow('c1', node.id, { source: 'auto' }),
      ).rejects.toBe(failure);
      expect(toastMock).toHaveBeenCalledTimes(2);
      if (!(failure instanceof NodeDuplicateFilesError)) {
        expect(toastMock.mock.calls.at(-1)?.[1].action.onClick).toBeTypeOf(
          'function',
        );
      }
      queue.discardCanvas('c1');
    },
  );

  it('retries retained failures without retrying new failures in the same drain', async () => {
    const node = noteNode('v1');
    const { queue } = makeQueue(node);
    queue.seedBaselines([node]);
    putMock.mockRejectedValue(new Error('offline'));
    queue.scheduleChanges('c1', [node], [noteNode('v2')]);
    await queue.flushAll();
    queue.retryFailedSaves('c1');
    await expect(queue.flushAllForSubmission('c1')).rejects.toThrow(
      'Content saves failed',
    );
    expect(putMock).toHaveBeenCalledTimes(2);
    putMock.mockResolvedValue({ nodeId: node.id, label: 'Note', rev: 'saved' });
    queue.retryFailedSaves('c1');
    await expect(queue.flushAllForSubmission('c1')).resolves.toBeUndefined();
    expect(putMock).toHaveBeenCalledTimes(3);
  });

  it.each(['offscreen', 'loading', 'conflict', 'duplicate'] as const)(
    'does not retry content against an unsafe state: %s',
    async (kind) => {
      const node = noteNode('v1');
      const { queue, state } = makeQueue(node);
      putMock.mockRejectedValue(
        kind === 'conflict'
          ? new CanvasConflictError({
              code: 'NODE_CONTENT_CONFLICT',
              message: 'conflict',
              currentRev: 'new',
            })
          : kind === 'duplicate'
            ? new NodeDuplicateFilesError({ message: 'duplicate' })
            : new Error('offline'),
      );
      queue.scheduleChanges('c1', [], [node]);
      await queue.flushAll();
      if (kind === 'offscreen') state.canvasId = 'other';
      if (kind === 'loading') {
        state.isLoading = true;
        state.nodes = [];
      }
      queue.retryFailedSaves('c1');
      await expect(queue.flushAllForSubmission('c1')).rejects.toThrow(
        'Content saves failed',
      );
      expect(putMock).toHaveBeenCalledOnce();
      queue.discardCanvas('c1');
    },
  );

  it('reports retained failures after a best-effort flush', async () => {
    const node = noteNode('v1');
    const { queue } = makeQueue(node);
    putMock.mockRejectedValue(new Error('disk fail'));
    queue.scheduleChanges('c1', [], [node]);
    await expect(queue.flushAll()).resolves.toBeUndefined();
    await expect(queue.flushAllForSubmission('c1')).rejects.toThrow(
      'Content saves failed',
    );
    putMock.mockResolvedValue({ nodeId: 'n1', label: 'Note', rev: 'saved' });
    await queue.flushNow('c1', 'n1');
    await expect(queue.flushAllForSubmission('c1')).resolves.toBeUndefined();
  });

  it('does not filter retained failures using nodes from an incomplete return load', async () => {
    const node = noteNode('v1');
    const { queue, state } = makeQueue(node);
    putMock.mockRejectedValue(new Error('disk fail'));
    queue.scheduleChanges('c1', [], [node]);
    await queue.flushAll();
    state.canvasId = 'parent';
    state.nodes = [];
    state.canvasId = 'c1';
    state.isLoading = true;
    await expect(queue.flushAllForSubmission('c1')).rejects.toThrow(
      'Content saves failed',
    );
    expect(putMock).toHaveBeenCalledOnce();
  });

  it('forgets only the discarded Space and retires its Retry action', async () => {
    const node = noteNode('v1');
    const { queue, state } = makeQueue(node);
    toastMock.mockReturnValue('failure-toast');
    putMock.mockRejectedValue(new Error('disk fail'));
    queue.scheduleChanges('c1', [], [node]);
    await queue.flushAll();
    const retry = toastMock.mock.calls.at(-1)?.[1].action.onClick;
    state.canvasId = 'other';
    state.nodes = [{ ...node, id: 'n2' }];
    queue.scheduleChanges('other', [], state.nodes);
    await queue.flushAll();
    queue.discardCanvas('c1');
    expect(dismissToast).toHaveBeenCalledWith('failure-toast');
    await expect(queue.flushAllForSubmission('c1')).resolves.toBeUndefined();
    await expect(queue.flushAllForSubmission('other')).rejects.toThrow(
      'Content saves failed',
    );
    state.canvasId = 'c1';
    state.nodes = [node];
    queue.seedBaselines([node]);
    retry();
    await tick();
    expect(putMock).toHaveBeenCalledTimes(2);
    queue.discardCanvas('other');
  });

  it('retires conflict actions after discard even when the same Space is reopened', async () => {
    const node = noteNode('local edit');
    const { queue, state } = makeQueue(node);
    toastMock.mockReturnValue('conflict-toast');
    putMock.mockRejectedValue(
      new CanvasConflictError({
        code: 'NODE_CONTENT_CONFLICT',
        message: 'stale',
        currentRev: 'server-rev',
      }),
    );
    await queue.flushNow('c1', node.id);
    const conflict = toastMock.mock.calls.at(-1)?.[1];
    queue.discardCanvas('c1');
    expect(dismissToast).toHaveBeenCalledWith('conflict-toast');
    state.nodes = [noteNode('server text')];
    queue.seedBaselines(state.nodes);
    conflict.secondaryAction.onClick();
    conflict.action.onClick();
    await tick();
    expect(putMock).toHaveBeenCalledOnce();
    expect(queue.pendingNodeIds()).toEqual([]);
    await expect(queue.flushAllForSubmission('c1')).resolves.toBeUndefined();
  });

  it('does not report a frozen content conflict as a successful submission save', async () => {
    const node = noteNode('v1');
    const { queue } = makeQueue(node);
    const conflict = new CanvasConflictError({
      code: 'NODE_CONTENT_CONFLICT',
      message: 'stale',
      currentRev: 'newer',
    });
    putMock.mockRejectedValue(conflict);
    await expect(queue.flushNow('c1', 'n1')).resolves.toBeUndefined();
    await expect(queue.flushAllForSubmission('c1')).rejects.toThrow(
      'Content saves failed',
    );
    expect(putMock).toHaveBeenCalledTimes(1);
  });

  it('does not flush active edits for an offscreen submission', async () => {
    const node = noteNode('v1');
    const { queue } = makeQueue(node);
    queue.scheduleChanges('c1', [], [node]);
    await expect(queue.flushAllForSubmission('other')).resolves.toBeUndefined();
    expect(putMock).not.toHaveBeenCalled();
    queue.forgetNode(node.id);
  });

  it('retains failed content saves for the original Space after navigation', async () => {
    const node = noteNode('v1');
    const { queue, state } = makeQueue(node);
    putMock.mockRejectedValue(new Error('disk fail'));
    queue.scheduleChanges('c1', [], [node]);
    await queue.flushAll();
    state.canvasId = 'parent';
    state.nodes = [];
    await expect(queue.flushAllForSubmission('c1')).rejects.toThrow(
      'Content saves failed',
    );
    await expect(
      queue.flushAllForSubmission('parent'),
    ).resolves.toBeUndefined();
    expect(putMock).toHaveBeenCalledOnce();
  });

  it('finishes the original content flush when navigation replaces the active Space', async () => {
    const node = noteNode('v1');
    const { queue, state } = makeQueue(node);
    putMock.mockImplementation(async () => {
      state.canvasId = 'parent';
      state.nodes = [];
      return { nodeId: 'n1', label: 'Note', rev: 'saved' };
    });
    queue.scheduleChanges('c1', [], [node]);
    await expect(queue.flushAllForSubmission('c1')).resolves.toBeUndefined();
    expect(putMock).toHaveBeenCalledOnce();
    expect(putMock.mock.calls[0][0]).toBe('c1');
  });

  it('surfaces a retryable danger toast even on the auto path', async () => {
    const node = noteNode('v1');
    const { queue } = makeQueue(node);
    queue.seedBaselines([node]);
    putMock.mockRejectedValue(new Error('disk fail'));

    await queue.flushNow('c1', 'n1', { source: 'auto' }).catch(() => undefined);

    expect(toastMock).toHaveBeenCalledTimes(1);
    const opts = toastMock.mock.calls[0][1];
    expect(opts.tone).toBe('danger');
    expect(typeof opts.action?.onClick).toBe('function');
  });

  it('throttles repeated auto failures to once per node', async () => {
    const node = noteNode('v1');
    const { queue } = makeQueue(node);
    queue.seedBaselines([node]);
    putMock.mockRejectedValue(new Error('disk fail'));

    await queue.flushNow('c1', 'n1', { source: 'auto' }).catch(() => undefined);
    await queue.flushNow('c1', 'n1', { source: 'auto' }).catch(() => undefined);

    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it('re-alerts after a success clears the throttle', async () => {
    const node = noteNode('v1');
    const { queue } = makeQueue(node);
    queue.seedBaselines([node]);

    putMock.mockRejectedValueOnce(new Error('disk fail'));
    await queue.flushNow('c1', 'n1', { source: 'auto' }).catch(() => undefined);
    expect(toastMock).toHaveBeenCalledTimes(1);

    putMock.mockResolvedValueOnce({ nodeId: 'n1', label: 'Note', rev: 'SRV1' });
    await queue.flushNow('c1', 'n1', { source: 'auto' }).catch(() => undefined);

    putMock.mockRejectedValueOnce(new Error('disk fail again'));
    await queue.flushNow('c1', 'n1', { source: 'auto' }).catch(() => undefined);
    expect(toastMock).toHaveBeenCalledTimes(2);
  });

  it('Retry action re-flushes the node', async () => {
    const node = noteNode('v1');
    const { queue } = makeQueue(node);
    queue.seedBaselines([node]);

    putMock.mockRejectedValueOnce(new Error('disk fail'));
    await queue.flushNow('c1', 'n1', { source: 'auto' }).catch(() => undefined);
    expect(putMock).toHaveBeenCalledTimes(1);

    const retry = toastMock.mock.calls[0][1].action.onClick as () => void;
    putMock.mockResolvedValueOnce({ nodeId: 'n1', label: 'Note', rev: 'SRV1' });
    retry();
    await tick();

    expect(putMock).toHaveBeenCalledTimes(2);
  });
});
