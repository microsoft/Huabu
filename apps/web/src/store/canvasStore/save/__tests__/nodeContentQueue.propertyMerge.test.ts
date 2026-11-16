// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * A property save refused as stale is made again on top of the server's
 * properties when the other save changed different keys, and is refused as
 * before when it changed the same key.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  CanvasConflictError,
  getNodeContent,
  putNodeContent,
} from '@/api/canvas';
import { toast } from '@/components/Common/Toast';

import { createNodeContentQueue } from '../nodeContentQueue';

import type * as CanvasApi from '@/api/canvas';
import type { GetNodeContentResponse } from '@huabu/shared';
import type { Node } from '@xyflow/react';

vi.mock('@/api/canvas', async (importActual) => {
  const actual = await importActual<typeof CanvasApi>();
  return { ...actual, getNodeContent: vi.fn(), putNodeContent: vi.fn() };
});

vi.mock('@/components/Common/Toast', () => ({
  toast: vi.fn(),
  dismissToast: vi.fn(),
}));

const putMock = putNodeContent as unknown as Mock;
const getMock = getNodeContent as unknown as Mock;
const toastMock = toast as unknown as Mock;

const stale = (currentRev = 'rev-other') =>
  new CanvasConflictError({
    code: 'NODE_CONTENT_CONFLICT',
    message: 'stale',
    currentRev,
  });

function setup(options: { editedElsewhere?: boolean } = {}) {
  const node = {
    id: 'n1',
    type: 'note',
    position: { x: 0, y: 0 },
    data: {
      content: 'body',
      label: 'Note',
      properties: { Venue: 'UIST', Year: 2024 },
      propertyDisplayKeys: ['Venue', 'Year'],
    },
  } as Node;
  const state = {
    canvasId: 'c1',
    isLoading: false,
    nodes: [node] as Node[],
    _setStateNoAutosave: vi.fn(({ nodes }: { nodes: Node[] }) => {
      state.nodes = nodes;
    }),
    patchNodeSilent: vi.fn(),
  };
  const adopted = vi.fn();
  const queue = createNodeContentQueue({
    delayMs: 0,
    getState: () => state,
    onRemoteContentAdopted: adopted,
    isEditedElsewhere: () => options.editedElsewhere === true,
  });
  queue.setBaselines([node], { n1: 'rev-0' });
  return { queue, state, node, adopted };
}

const server = (
  patch: Partial<GetNodeContentResponse> = {},
): GetNodeContentResponse =>
  ({
    nodeId: 'n1',
    content: 'body',
    label: 'Note',
    properties: { Venue: 'UIST', Year: 2024 },
    propertyDisplayKeys: ['Venue', 'Year'],
    rev: 'rev-other',
    ...patch,
  }) as GetNodeContentResponse;

const saved = (rev: string) => ({ nodeId: 'n1', label: 'Note', rev });

beforeEach(() => {
  putMock.mockReset();
  getMock.mockReset();
  toastMock.mockReset();
});

describe('a property save refused as stale', () => {
  it('is made again on top of another page’s different key, and both survive', async () => {
    const { queue, state, adopted } = setup();
    putMock.mockRejectedValueOnce(stale());
    getMock.mockResolvedValueOnce(
      server({
        properties: { Venue: 'UIST', Year: 2024, Rating: 5 },
        propertyDisplayKeys: ['Venue', 'Year', 'Rating'],
      }),
    );
    putMock.mockResolvedValueOnce(saved('rev-mine'));

    await queue.commitProperties('c1', 'n1', {
      properties: { Status: 'Read' },
      propertyDisplayKeys: ['Venue', 'Year', 'Status'],
    });

    expect(putMock).toHaveBeenCalledTimes(2);
    const second = putMock.mock.calls[1][2];
    expect(second.expectRev).toBe('rev-other');
    expect(second.properties).toEqual({
      Venue: 'UIST',
      Year: 2024,
      Rating: 5,
      Status: 'Read',
    });
    expect(second.propertyDisplayKeys).toEqual([
      'Venue',
      'Year',
      'Rating',
      'Status',
    ]);
    // The other page's key is shown, the node is not frozen, nobody is told.
    expect(state.nodes[0].data.properties).toMatchObject({
      Rating: 5,
      Status: 'Read',
    });
    expect(state.nodes[0].data.propertyDisplayKeys).toEqual([
      'Venue',
      'Year',
      'Rating',
      'Status',
    ]);
    expect(adopted).toHaveBeenCalledTimes(1);
    expect(toastMock).not.toHaveBeenCalled();
    expect(queue.pendingNodeIds()).toEqual([]);
    expect(queue.hasUnsavedContent('c1')).toBe(false);
  });

  it('removes its key while keeping the key another page added', async () => {
    const { queue, state } = setup();
    putMock.mockRejectedValueOnce(stale());
    getMock.mockResolvedValueOnce(
      server({
        properties: { Venue: 'UIST', Year: 2025 },
      }),
    );
    putMock.mockResolvedValueOnce(saved('rev-mine'));

    await queue.commitProperties('c1', 'n1', {
      properties: { Venue: null },
      propertyDisplayKeys: ['Year'],
    });

    const second = putMock.mock.calls[1][2];
    expect(second.properties).toEqual({ Venue: null, Year: 2025 });
    expect(second.propertyDisplayKeys).toEqual(['Year']);
    expect(state.nodes[0].data.properties).toEqual({ Year: 2025 });
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('stays refused, with the node as it was, when the other save changed the same key', async () => {
    const { queue, state, node, adopted } = setup();
    putMock.mockRejectedValueOnce(stale());
    getMock.mockResolvedValueOnce(
      server({ properties: { Venue: 'DIS', Year: 2024 } }),
    );

    await expect(
      queue.commitProperties('c1', 'n1', { properties: { Venue: 'CHI' } }),
    ).rejects.toMatchObject({ code: 'NODE_CONTENT_CONFLICT' });

    expect(putMock).toHaveBeenCalledTimes(1);
    expect(state.nodes[0]).toBe(node);
    expect(adopted).not.toHaveBeenCalled();
    // Today's refusal: the node is frozen and the choice is offered.
    expect(queue.pendingNodeIds()).toEqual(['n1']);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][1]).toMatchObject({ tone: 'danger' });
  });

  it('gives up after three merges and reports the refusal', async () => {
    const { queue } = setup();
    putMock.mockRejectedValue(stale());
    let rating = 0;
    getMock.mockImplementation(async () =>
      server({
        properties: { Venue: 'UIST', Year: 2024, Rating: (rating += 1) },
        rev: `rev-${rating}`,
      }),
    );

    await expect(
      queue.commitProperties('c1', 'n1', { properties: { Status: 'Read' } }),
    ).rejects.toMatchObject({ code: 'NODE_CONTENT_CONFLICT' });

    expect(putMock).toHaveBeenCalledTimes(4);
    expect(getMock).toHaveBeenCalledTimes(3);
    expect(putMock.mock.calls.map((call) => call[2].expectRev)).toEqual([
      'rev-0',
      'rev-1',
      'rev-2',
      'rev-3',
    ]);
    expect(queue.pendingNodeIds()).toEqual(['n1']);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it('merges with an agent’s write to other keys that arrived while the save was on the wire', async () => {
    const { queue, state } = setup();
    const agentNode = {
      ...state.nodes[0],
      data: {
        ...state.nodes[0].data,
        properties: { Venue: 'UIST', Year: 2024, Topic: 'HCI' },
      },
    } as Node;
    putMock.mockImplementationOnce(async () => {
      // The update for the agent's batch: the node is unsaved here, so the
      // store keeps its properties and only the baseline moves.
      queue.setBaselines([agentNode], { n1: 'rev-agent' });
      throw stale('rev-agent');
    });
    getMock.mockResolvedValueOnce(
      server({
        properties: agentNode.data.properties,
        rev: 'rev-agent',
      } as never),
    );
    putMock.mockResolvedValueOnce(saved('rev-mine'));

    await queue.commitProperties('c1', 'n1', { properties: { Venue: 'CHI' } });

    const second = putMock.mock.calls[1][2];
    expect(second.expectRev).toBe('rev-agent');
    // The agent's key is sent as it is, never as a removal.
    expect(second.properties).toEqual({
      Venue: 'CHI',
      Year: 2024,
      Topic: 'HCI',
    });
    expect(state.nodes[0].data.properties).toEqual({
      Venue: 'CHI',
      Year: 2024,
      Topic: 'HCI',
    });
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('refuses when an agent changed the very key while the save was on the wire', async () => {
    const { queue, state } = setup();
    const agentNode = {
      ...state.nodes[0],
      data: {
        ...state.nodes[0].data,
        properties: { Venue: 'DIS', Year: 2024 },
      },
    } as Node;
    putMock.mockImplementationOnce(async () => {
      queue.setBaselines([agentNode], { n1: 'rev-agent' });
      throw stale('rev-agent');
    });
    getMock.mockResolvedValueOnce(
      server({
        properties: agentNode.data.properties,
        rev: 'rev-agent',
      } as never),
    );

    await expect(
      queue.commitProperties('c1', 'n1', { properties: { Venue: 'CHI' } }),
    ).rejects.toMatchObject({ code: 'NODE_CONTENT_CONFLICT' });
    expect(putMock).toHaveBeenCalledTimes(1);
    expect(state.nodes[0].data.properties).toEqual({
      Venue: 'UIST',
      Year: 2024,
    });
  });

  it('takes a body another page finished, but not one it is still editing', async () => {
    const fresh = server({
      content: 'their body',
      properties: { Venue: 'UIST', Year: 2024 },
    });
    {
      const { queue, state } = setup();
      putMock.mockRejectedValueOnce(stale());
      getMock.mockResolvedValueOnce(fresh);
      putMock.mockResolvedValueOnce(saved('rev-mine'));
      await queue.commitProperties('c1', 'n1', {
        properties: { Venue: 'CHI' },
      });
      expect(putMock.mock.calls[1][2].content).toBe('their body');
      expect(state.nodes[0].data).toMatchObject({
        content: 'their body',
        properties: { Venue: 'CHI', Year: 2024 },
      });
    }
    putMock.mockReset();
    getMock.mockReset();
    {
      const { queue, state } = setup({ editedElsewhere: true });
      putMock.mockRejectedValueOnce(stale());
      getMock.mockResolvedValueOnce(fresh);
      await expect(
        queue.commitProperties('c1', 'n1', { properties: { Venue: 'CHI' } }),
      ).rejects.toMatchObject({ code: 'NODE_CONTENT_CONFLICT' });
      expect(putMock).toHaveBeenCalledTimes(1);
      expect(state.nodes[0].data.content).toBe('body');
    }
  });

  it('does not merge over other unsaved content of the node, or when the fetch fails', async () => {
    {
      const { queue, state } = setup();
      const previous = state.nodes;
      state.nodes = [
        { ...previous[0], data: { ...previous[0].data, content: 'typed' } },
      ];
      queue.scheduleChanges('c1', previous, state.nodes);
      putMock.mockRejectedValueOnce(stale());
      await expect(
        queue.commitProperties('c1', 'n1', { properties: { Venue: 'CHI' } }),
      ).rejects.toMatchObject({ code: 'NODE_CONTENT_CONFLICT' });
      expect(getMock).not.toHaveBeenCalled();
      expect(state.nodes[0].data.content).toBe('typed');
    }
    putMock.mockReset();
    {
      const { queue } = setup();
      putMock.mockRejectedValueOnce(stale());
      getMock.mockResolvedValueOnce(null);
      await expect(
        queue.commitProperties('c1', 'n1', { properties: { Venue: 'CHI' } }),
      ).rejects.toMatchObject({ code: 'NODE_CONTENT_CONFLICT' });
      expect(putMock).toHaveBeenCalledTimes(1);
    }
  });
});
