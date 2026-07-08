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

import { nodeRevisionOf } from '@sediment/shared/canvas-engine';

import { CanvasConflictError, putNodeContent } from '@/api/canvas';
import { toast } from '@/components/Common/Toast';

import { createNodeContentQueue } from '../nodeContentQueue';

import type * as CanvasApi from '@/api/canvas';
import type { Node } from '@xyflow/react';

vi.mock('@/api/canvas', async (importActual) => {
  const actual = await importActual<typeof CanvasApi>();
  return { ...actual, putNodeContent: vi.fn() };
});

vi.mock('@/components/Common/Toast', () => ({
  toast: vi.fn(),
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

  it('on NODE_CONTENT_CONFLICT: no throw, keeps text, toasts once', async () => {
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

    // A second refused write does not re-toast (once per node).
    await queue.flushNow('c1', 'n1');
    expect(toastMock).toHaveBeenCalledTimes(1);
  });
});
