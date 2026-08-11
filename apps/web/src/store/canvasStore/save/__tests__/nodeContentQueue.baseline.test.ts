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

import { createNodeContentQueue } from '../nodeContentQueue';

import type * as CanvasApi from '@/api/canvas';
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

function makeQueue(node: Node) {
  const state = {
    canvasId: 'c1',
    nodes: [node] as Node[],
    _setStateNoAutosave: vi.fn(),
    patchNodeSilent: vi.fn(),
  };
  const queue = createNodeContentQueue({
    delayMs: 0,
    getState: () => state,
  });
  return { queue, state };
}

beforeEach(() => {
  putMock.mockReset();
  getMock.mockReset();
  toastMock.mockReset();
});

describe('nodeContentQueue baseline lifecycle', () => {
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

  it('rebases a skipped remote write without replacing local content', async () => {
    const node = noteNode('local edit');
    const { queue, state } = makeQueue(node);
    queue.seedBaselines([node]);

    const rebase = queue.beginBaselineRebase('n1');
    putMock.mockResolvedValueOnce({ nodeId: 'n1', label: 'Note', rev: 'SRV2' });
    await queue.completeBaselineRebase('c1', rebase, 'REMOTE_REV');

    expect(putMock.mock.calls[0][2]).toMatchObject({
      content: 'local edit',
      expectRev: 'REMOTE_REV',
    });
    expect(state.nodes[0]?.data?.['content']).toBe('local edit');
  });

  it('rebases after an older in-flight PUT conflicts, then retries local content', async () => {
    const node = noteNode('local edit');
    const { queue } = makeQueue(node);
    queue.seedBaselines([node]);
    let rejectFirst: ((reason: unknown) => void) | undefined;
    putMock.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }),
    );

    const first = queue.flushNow('c1', 'n1');
    await vi.waitFor(() => expect(putMock).toHaveBeenCalledOnce());
    const rebase = queue.beginBaselineRebase('n1');
    putMock.mockResolvedValueOnce({ nodeId: 'n1', label: 'Note', rev: 'SRV2' });
    const rebased = queue.completeBaselineRebase('c1', rebase, 'REMOTE_REV');
    rejectFirst?.(
      new CanvasConflictError({
        code: 'NODE_CONTENT_CONFLICT',
        message: 'remote write won',
        nodeId: 'n1',
        currentRev: 'REMOTE_REV',
      }),
    );

    await first;
    await rebased;

    expect(putMock).toHaveBeenCalledTimes(2);
    expect(putMock.mock.calls[1][2]).toMatchObject({
      content: 'local edit',
      expectRev: 'REMOTE_REV',
    });
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
    expect(queue.pendingNodeIds()).toContain('n1');
  });

  it('ignores a late content conflict after the local node was deleted', async () => {
    const node = noteNode('v1');
    const { queue, state } = makeQueue(node);
    queue.seedBaselines([node]);
    let rejectPut: ((reason: unknown) => void) | undefined;
    putMock.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectPut = reject;
      }),
    );

    const pending = queue.flushNow('c1', 'n1');
    await vi.waitFor(() => expect(putMock).toHaveBeenCalledOnce());
    state.nodes = [];
    queue.forgetNode('n1');
    rejectPut?.(
      new CanvasConflictError({
        code: 'NODE_CONTENT_CONFLICT',
        message: 'topology was deleted',
        nodeId: 'n1',
        currentRev: 'MISSING',
      }),
    );
    await pending;

    expect(toastMock).not.toHaveBeenCalled();
    expect(queue.pendingNodeIds()).not.toContain('n1');

    // Reusing the id in this isolated regression proves the obsolete 409 did
    // not resurrect a frozen entry that suppresses all future writes.
    state.nodes = [noteNode('replacement')];
    putMock.mockResolvedValueOnce({ nodeId: 'n1', label: 'Note', rev: 'NEW' });
    await queue.flushNow('c1', 'n1');
    expect(putMock).toHaveBeenCalledTimes(2);
  });

  it('does not let a delayed Load latest overwrite typing made after the click', async () => {
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
    await queue.flushNow('c1', 'n1');

    let resolveGet: ((value: unknown) => void) | undefined;
    getMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGet = resolve;
      }),
    );
    const loadLatest = toastMock.mock.calls[0][1].action.onClick as () => void;
    loadLatest();
    await vi.waitFor(() => expect(getMock).toHaveBeenCalledOnce());
    state.nodes = [noteNode('typed after click')];
    resolveGet?.({
      nodeId: 'n1',
      type: 'note',
      label: 'Remote',
      content: 'remote',
      rev: 'REMOTE',
    });
    await vi.waitFor(() => expect(getMock).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(state._setStateNoAutosave).not.toHaveBeenCalled();
    expect(state.nodes[0]?.data?.['content']).toBe('typed after click');
    expect(queue.pendingNodeIds()).toContain('n1');
  });

  it('adopts contentMissing when Load latest finds a deleted sidecar', async () => {
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

    await queue.flushNow('c1', 'n1');
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
  });

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
    // Let the forced flush settle.
    await Promise.resolve();
    await Promise.resolve();

    // The forced write carries the disk rev we collided with, so it
    // deliberately overwrites the other change.
    const forced = putMock.mock.calls[1][2];
    expect(forced.expectRev).toBe('DISK_REV');
  });
});
