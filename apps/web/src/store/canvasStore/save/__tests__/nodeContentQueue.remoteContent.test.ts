// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Another page saved a node's sidecar. The queue fetches it and shows it
 * together with its revision, unless this page has unsaved content of its
 * own for the node.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import {
  CanvasConflictError,
  getNodeContent,
  putNodeContent,
} from '@/api/canvas';

import { createNodeContentQueue } from '../nodeContentQueue';

import type * as CanvasApi from '@/api/canvas';
import type { GetNodeContentResponse } from '@huabu/shared';
import type { Node } from '@xyflow/react';

vi.mock('@/api/canvas', async (importActual) => {
  const actual = await importActual<typeof CanvasApi>();
  return { ...actual, getNodeContent: vi.fn(), putNodeContent: vi.fn() };
});
vi.mock('@/components/Common/Toast', () => ({
  toast: vi.fn(() => 'toast'),
  dismissToast: vi.fn(),
}));

const putMock = putNodeContent as unknown as Mock;
const getMock = getNodeContent as unknown as Mock;

const note = (data: Record<string, unknown>, id = 'n1', type = 'note'): Node =>
  ({ id, type, position: { x: 0, y: 0 }, data }) as Node;

function saved(
  content: string,
  extra: Partial<GetNodeContentResponse> = {},
): GetNodeContentResponse {
  return {
    nodeId: 'n1',
    type: 'note',
    label: 'Note',
    content,
    rev: nodeRevisionOf({ content }),
    ...extra,
  };
}

function makeQueue(nodes: Node[]) {
  const adopted = vi.fn();
  const state = {
    canvasId: 'c1',
    isLoading: false,
    nodes,
    _setStateNoAutosave: vi.fn((partial: { nodes: Node[] }) => {
      state.nodes = partial.nodes;
    }),
    patchNodeSilent: vi.fn(),
  };
  const queue = createNodeContentQueue({
    delayMs: 0,
    getState: () => state,
    pageId: 'page-b',
    onRemoteContentAdopted: adopted,
  });
  queue.setBaselines(nodes);
  /** The person edits a node on this page. */
  const edit = (id: string, patch: Record<string, unknown>) => {
    const prev = state.nodes;
    state.nodes = prev.map((node) =>
      node.id === id ? { ...node, data: { ...node.data, ...patch } } : node,
    );
    queue.scheduleChanges('c1', prev, state.nodes);
  };
  const data = (id = 'n1') =>
    state.nodes.find((node) => node.id === id)?.data as Record<string, unknown>;
  return { queue, state, adopted, edit, data };
}

beforeEach(() => {
  putMock.mockReset();
  getMock.mockReset();
});

describe('adopting content another page saved', () => {
  it('shows the saved body and label and saves nothing back', async () => {
    const other = note({ content: 'other', label: 'Other' }, 'n2');
    const { queue, state, adopted, data } = makeQueue([
      note({ content: 'old', label: 'Note' }),
      other,
    ]);
    getMock.mockResolvedValue(
      saved('from page A', { label: 'Renamed', labelSource: 'user' }),
    );

    await expect(queue.adoptRemoteContent('c1', 'n1')).resolves.toBe('applied');

    expect(getMock).toHaveBeenCalledWith('c1', 'n1');
    expect(data()).toMatchObject({
      content: 'from page A',
      label: 'Renamed',
      labelSource: 'user',
    });
    // The other node keeps its identity, so only this card re-renders.
    expect(state.nodes[1]).toBe(other);
    expect(adopted).toHaveBeenCalledWith('c1', 'n1', {
      content: 'from page A',
      label: 'Renamed',
      labelSource: 'user',
    });
    expect(queue.pendingNodeIds()).toEqual([]);
    expect(queue.hasUnsavedContent('c1')).toBe(false);
    await queue.flushAll();
    expect(putMock).not.toHaveBeenCalled();
  });

  it("sends this page's next save from the adopted revision", async () => {
    const { queue, edit } = makeQueue([
      note({ content: 'old', label: 'Note' }),
    ]);
    getMock.mockResolvedValue(saved('from page A'));
    await queue.adoptRemoteContent('c1', 'n1');

    putMock.mockResolvedValue({ nodeId: 'n1', label: 'Note', rev: 'next' });
    edit('n1', { content: 'from page A, continued on page B' });
    await queue.flushAll();

    expect(putMock).toHaveBeenCalledTimes(1);
    expect(putMock.mock.calls[0][2]).toMatchObject({
      content: 'from page A, continued on page B',
      expectRev: nodeRevisionOf({ content: 'from page A' }),
      pageId: 'page-b',
    });
  });

  it('only moves the baseline when the node already shows the saved content', async () => {
    const { queue, state, adopted, edit } = makeQueue([
      note({ content: 'same', label: 'Note', keywords: ['a', 'b'] }),
    ]);
    getMock.mockResolvedValue(
      saved('same', { keywords: ['a', 'b'], rev: 'server-rev' }),
    );

    await expect(queue.adoptRemoteContent('c1', 'n1')).resolves.toBe(
      'unchanged',
    );
    expect(state._setStateNoAutosave).not.toHaveBeenCalled();
    expect(adopted).not.toHaveBeenCalled();

    putMock.mockResolvedValue({ nodeId: 'n1', label: 'Note', rev: 'next' });
    edit('n1', { content: 'mine' });
    await queue.flushAll();
    expect(putMock.mock.calls[0][2]).toMatchObject({ expectRev: 'server-rev' });
  });

  it('leaves fields the response does not carry, and gives no body to a bodyless node', async () => {
    const { queue, data } = makeQueue([
      note({ label: 'Frame', summary: 'kept' }, 'n1', 'frame'),
    ]);
    getMock.mockResolvedValue(
      saved('', { type: 'frame', label: 'Renamed frame' }),
    );

    await queue.adoptRemoteContent('c1', 'n1');

    expect(data()).toEqual({ label: 'Renamed frame', summary: 'kept' });
  });

  it('keeps a node with a queued edit untouched and fetches it once that edit is saved', async () => {
    const { queue, state, edit, data } = makeQueue([
      note({ content: 'old', label: 'Note' }),
    ]);
    edit('n1', { content: 'typed here' });

    await expect(queue.adoptRemoteContent('c1', 'n1')).resolves.toBe(
      'kept-local',
    );
    expect(getMock).not.toHaveBeenCalled();
    expect(state._setStateNoAutosave).not.toHaveBeenCalled();
    expect(data()['content']).toBe('typed here');

    putMock.mockResolvedValue({ nodeId: 'n1', label: 'Note', rev: 'mine' });
    getMock.mockResolvedValue(
      saved('typed here', { summary: 'summary from page A', rev: 'mine' }),
    );
    await queue.flushAll();
    await vi.waitFor(() =>
      expect(data()['summary']).toBe('summary from page A'),
    );
    expect(data()['content']).toBe('typed here');
    expect(putMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing conflict choice when this page saves over a body it never adopted', async () => {
    const { queue, edit, data } = makeQueue([
      note({ content: 'old', label: 'Note' }),
    ]);
    edit('n1', { content: 'typed here' });
    await queue.adoptRemoteContent('c1', 'n1');
    putMock.mockRejectedValue(
      new CanvasConflictError({
        code: 'NODE_CONTENT_CONFLICT',
        message: 'stale',
        nodeId: 'n1',
        currentRev: nodeRevisionOf({ content: 'from page A' }),
      }),
    );

    await queue.flushAll();

    // Sent from the stale revision, refused, and the text stays.
    expect(putMock.mock.calls[0][2]).toMatchObject({
      expectRev: nodeRevisionOf({ content: 'old' }),
    });
    expect(data()['content']).toBe('typed here');
    expect(queue.pendingNodeIds()).toContain('n1');
    // A conflicted node is not overwritten by a later save either: what
    // the server holds is only compared with the text, never put into it.
    getMock.mockResolvedValue(saved('from page A again', { rev: 'again' }));
    await expect(queue.adoptRemoteContent('c1', 'n1')).resolves.toBe(
      'kept-local',
    );
    expect(data()['content']).toBe('typed here');
    expect(queue.pendingNodeIds()).toContain('n1');
  });

  it('does not overwrite text typed while the fetch was under way', async () => {
    const { queue, state, edit, data } = makeQueue([
      note({ content: 'old', label: 'Note' }),
    ]);
    let respond!: (value: GetNodeContentResponse) => void;
    getMock.mockReturnValue(
      new Promise<GetNodeContentResponse>((resolve) => {
        respond = resolve;
      }),
    );

    const outcome = queue.adoptRemoteContent('c1', 'n1');
    edit('n1', { content: 'typed during the fetch' });
    respond(saved('from page A'));

    await expect(outcome).resolves.toBe('kept-local');
    expect(state._setStateNoAutosave).not.toHaveBeenCalled();
    expect(data()['content']).toBe('typed during the fetch');
  });

  it('reads a save that lands during a fetch with one more fetch', async () => {
    const { queue, data } = makeQueue([
      note({ content: 'old', label: 'Note' }),
    ]);
    const responses: Array<(value: GetNodeContentResponse) => void> = [];
    getMock.mockImplementation(
      () =>
        new Promise<GetNodeContentResponse>((resolve) => {
          responses.push(resolve);
        }),
    );

    const first = queue.adoptRemoteContent('c1', 'n1');
    const second = queue.adoptRemoteContent('c1', 'n1');
    const third = queue.adoptRemoteContent('c1', 'n1');
    expect(getMock).toHaveBeenCalledTimes(1);
    responses[0](saved('first save'));
    await vi.waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
    responses[1](saved('second save'));

    await expect(Promise.all([first, second, third])).resolves.toEqual([
      'applied',
      'applied',
      'applied',
    ]);
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(data()['content']).toBe('second save');
  });

  it('never adopts a missing sidecar or a failed fetch as an empty body', async () => {
    const { queue, state, data } = makeQueue([
      note({ content: 'old', label: 'Note' }),
    ]);

    getMock.mockResolvedValueOnce(
      saved('', { label: null, contentMissing: true }),
    );
    await expect(queue.adoptRemoteContent('c1', 'n1')).resolves.toBe('absent');
    getMock.mockResolvedValueOnce(null);
    await expect(queue.adoptRemoteContent('c1', 'n1')).resolves.toBe('failed');

    expect(state._setStateNoAutosave).not.toHaveBeenCalled();
    expect(data()).toEqual({ content: 'old', label: 'Note' });
  });

  it('ignores a node this page does not have, another Space and a node deleted meanwhile', async () => {
    const { queue, state } = makeQueue([note({ content: 'old' })]);

    await expect(queue.adoptRemoteContent('c1', 'gone')).resolves.toBe(
      'absent',
    );
    await expect(queue.adoptRemoteContent('c2', 'n1')).resolves.toBe('absent');
    expect(getMock).not.toHaveBeenCalled();

    let respond!: (value: GetNodeContentResponse) => void;
    getMock.mockReturnValue(
      new Promise<GetNodeContentResponse>((resolve) => {
        respond = resolve;
      }),
    );
    const outcome = queue.adoptRemoteContent('c1', 'n1');
    state.nodes = [];
    respond(saved('from page A'));
    await expect(outcome).resolves.toBe('absent');
    expect(state._setStateNoAutosave).not.toHaveBeenCalled();
  });
});
