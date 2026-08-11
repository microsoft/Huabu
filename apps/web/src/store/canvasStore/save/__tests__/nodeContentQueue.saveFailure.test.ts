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

import { putNodeContent } from '@/api/canvas';
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
  it('surfaces a retryable danger toast even on the auto path', async () => {
    const node = noteNode('v1');
    const { queue } = makeQueue(node);
    queue.seedBaselines([node]);
    putMock.mockRejectedValue(new Error('disk fail'));

    await queue.flushNow('c1', 'n1', { source: 'auto' }).catch(() => undefined);

    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(queue.pendingNodeIds()).toContain('n1');
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
    expect(queue.pendingNodeIds()).not.toContain('n1');

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

  it('does not roll a newer rename back for an older failed request', async () => {
    const node = noteNode('v1', 'First');
    node.data = { ...node.data, labelSource: 'user' };
    const { queue, state } = makeQueue(node);
    queue.seedBaselines([node]);
    putMock.mockResolvedValueOnce({
      nodeId: 'n1',
      label: 'First',
      rev: 'BASE',
    });
    await queue.flushNow('c1', 'n1');

    const secondNode = noteNode('v1', 'Second');
    secondNode.data = { ...secondNode.data, labelSource: 'user' };
    state.nodes = [secondNode];
    let rejectPut: ((reason: unknown) => void) | undefined;
    putMock.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectPut = reject;
      }),
    );
    const second = queue.flushNow('c1', 'n1').catch(() => undefined);
    await vi.waitFor(() => expect(putMock).toHaveBeenCalledTimes(2));

    const thirdNode = noteNode('v1', 'Third');
    thirdNode.data = { ...thirdNode.data, labelSource: 'user' };
    state.nodes = [thirdNode];
    rejectPut?.(new Error('older request failed'));
    await second;

    expect(state._setStateNoAutosave).not.toHaveBeenCalled();
    expect(state.nodes[0]?.data?.['label']).toBe('Third');
  });
});
