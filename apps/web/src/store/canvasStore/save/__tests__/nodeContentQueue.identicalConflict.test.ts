// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * A save refused as stale is not a conflict when the server holds exactly
 * the content the page was saving: no freeze, no toast, the server's
 * revision as the baseline. One character of difference is a conflict.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import {
  CanvasConflictError,
  getNodeContent,
  putNodeContent,
} from '@/api/canvas';
import { dismissToast, toast } from '@/components/Common/Toast';

import { createNodeContentQueue } from '../nodeContentQueue';

import type * as CanvasApi from '@/api/canvas';
import type { Node } from '@xyflow/react';

vi.mock('@/api/canvas', async (importActual) => {
  const actual = await importActual<typeof CanvasApi>();
  return { ...actual, getNodeContent: vi.fn(), putNodeContent: vi.fn() };
});

vi.mock('@/components/Common/Toast', () => ({
  toast: vi.fn(() => 'conflict-toast'),
  dismissToast: vi.fn(),
}));

const putMock = putNodeContent as unknown as Mock;
const getMock = getNodeContent as unknown as Mock;
const toastMock = toast as unknown as Mock;
const dismissMock = dismissToast as unknown as Mock;

const stale = (currentRev: string) =>
  new CanvasConflictError({
    code: 'NODE_CONTENT_CONFLICT',
    message: 'stale',
    currentRev,
  });
const saved = (rev: string) => ({ nodeId: 'n1', label: 'Note', rev });

function setup(type: 'note' | 'pdf' = 'note') {
  const node = {
    id: 'n1',
    type,
    position: { x: 0, y: 0 },
    data:
      type === 'note'
        ? { content: 'seed', label: 'Note' }
        : { label: 'Paper', src: 'paper.pdf', properties: { Venue: 'CHI' } },
  } as Node;
  const state = {
    canvasId: 'c1',
    isLoading: false,
    nodes: [node] as Node[],
    _setStateRaw: vi.fn(({ nodes }: { nodes: Node[] }) => {
      state.nodes = nodes;
    }),
    patchNodeSilent: vi.fn(),
  };
  const persisted = vi.fn();
  const queue = createNodeContentQueue({
    delayMs: 0,
    getState: () => state,
    onContentPersisted: persisted,
  });
  queue.setBaselines([node], { n1: 'rev-seed' });
  const edit = (data: Record<string, unknown>) => {
    const previous = state.nodes;
    state.nodes = [
      { ...previous[0], data: { ...previous[0].data, ...data } } as Node,
    ];
    queue.scheduleChanges('c1', previous, state.nodes);
  };
  return { queue, state, edit, persisted };
}

beforeEach(() => {
  putMock.mockReset();
  getMock.mockReset();
  toastMock.mockClear();
  dismissMock.mockReset();
});

describe('a save refused although the server holds the same content', () => {
  it('is settled from the refusal itself when its revision is the one being saved', async () => {
    const { queue, state, edit } = setup();
    edit({ content: 'same text', label: 'My title' });
    const typed = state.nodes[0];
    const serverRev = nodeRevisionOf({ type: 'note', content: 'same text' });
    putMock.mockRejectedValueOnce(stale(serverRev));
    putMock.mockResolvedValueOnce({ ...saved(serverRev), label: 'My title' });

    await queue.flushNow('c1', 'n1');

    // No question is asked, at any moment, and nothing is fetched.
    expect(toastMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
    // The text (and so the caret) is not touched.
    expect(state.nodes[0]).toBe(typed);
    expect(state._setStateRaw).not.toHaveBeenCalled();
    // The server's revision is the baseline; the title is saved on it.
    expect(putMock).toHaveBeenCalledTimes(2);
    expect(putMock.mock.calls[1][2]).toMatchObject({
      content: 'same text',
      label: 'My title',
      expectRev: serverRev,
    });
    expect(queue.unsavedNodeIds('c1')).toEqual([]);
    expect(queue.hasUnsavedContent('c1')).toBe(false);
  });

  it('is settled by a fetch when the page cannot compute the server revision', async () => {
    // A PDF's extracted text is part of its revision and is not on the page.
    // The save carries a summary, so it quotes a revision. The properties
    // the server holds differ from the page's: they are not what is compared.
    const { queue, edit } = setup('pdf');
    edit({ summary: 'A summary derived here' });
    putMock.mockRejectedValueOnce(stale('rev-with-extracted-text'));
    getMock.mockResolvedValueOnce({
      nodeId: 'n1',
      label: 'Paper',
      content: 'Extracted text only the server holds',
      src: 'paper.pdf',
      properties: { Status: 'Read', Venue: 'UIST' },
      propertyDisplayKeys: ['Status'],
      rev: 'rev-with-extracted-text',
    });
    putMock.mockResolvedValueOnce({
      ...saved('rev-with-extracted-text'),
      label: 'Paper',
    });

    await queue.flushNow('c1', 'n1');

    expect(toastMock).not.toHaveBeenCalled();
    expect(putMock.mock.calls[1][2].expectRev).toBe('rev-with-extracted-text');
    expect(queue.unsavedNodeIds('c1')).toEqual([]);
  });

  it('is a conflict when the server content differs by one character', async () => {
    const { queue, state, edit } = setup();
    edit({ content: 'same text' });
    putMock.mockRejectedValueOnce(
      stale(nodeRevisionOf({ type: 'note', content: 'same text.' })),
    );
    getMock.mockResolvedValueOnce({
      nodeId: 'n1',
      label: 'Note',
      content: 'same text.',
      rev: nodeRevisionOf({ type: 'note', content: 'same text.' }),
    });

    await queue.flushNow('c1', 'n1').catch(() => undefined);

    expect(putMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][1]).toMatchObject({ tone: 'danger' });
    expect(state.nodes[0].data.content).toBe('same text');
    expect(queue.unsavedNodeIds('c1')).toEqual(['n1']);
  });

  it('is a conflict when the server moves again before the second save', async () => {
    const { queue, edit } = setup();
    edit({ content: 'same text' });
    const serverRev = nodeRevisionOf({ type: 'note', content: 'same text' });
    putMock.mockRejectedValueOnce(stale(serverRev));
    putMock.mockRejectedValueOnce(stale('rev-moved-again'));

    await queue.flushNow('c1', 'n1').catch(() => undefined);

    expect(putMock).toHaveBeenCalledTimes(2);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(queue.unsavedNodeIds('c1')).toEqual(['n1']);
  });
});

describe('a node frozen by a conflict', () => {
  async function freeze() {
    const context = setup();
    context.edit({ content: 'Mine' });
    putMock.mockRejectedValueOnce(stale('rev-theirs'));
    getMock.mockResolvedValueOnce({
      nodeId: 'n1',
      label: 'Note',
      content: 'Theirs',
      rev: 'rev-theirs',
    });
    await context.queue.flushNow('c1', 'n1').catch(() => undefined);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(context.queue.unsavedNodeIds('c1')).toEqual(['n1']);
    putMock.mockReset();
    getMock.mockReset();
    return context;
  }
  const mineRev = nodeRevisionOf({ type: 'note', content: 'Mine' });

  it('is released, silently, when another save left the same content', async () => {
    const { queue, state, persisted } = await freeze();
    const typed = state.nodes[0];
    getMock.mockResolvedValueOnce({
      nodeId: 'n1',
      label: 'Note',
      content: 'Mine',
      rev: mineRev,
    });

    expect(await queue.adoptRemoteContent('c1', 'n1')).toBe('unchanged');

    expect(dismissMock).toHaveBeenCalledWith('conflict-toast');
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(state.nodes[0]).toBe(typed);
    expect(queue.unsavedNodeIds('c1')).toEqual([]);
    expect(persisted).toHaveBeenCalledWith('c1', 'n1');
    // The next edit descends from the server's revision.
    putMock.mockResolvedValue(saved('rev-next'));
    const previous = state.nodes;
    state.nodes = [
      { ...previous[0], data: { ...previous[0].data, content: 'Mine!' } },
    ];
    queue.scheduleChanges('c1', previous, state.nodes);
    await queue.flushNow('c1', 'n1');
    expect(putMock.mock.calls[0][2]).toMatchObject({
      content: 'Mine!',
      expectRev: mineRev,
    });
  });

  it('stays frozen when the other save differs by one character', async () => {
    const { queue, state } = await freeze();
    getMock.mockResolvedValueOnce({
      nodeId: 'n1',
      label: 'Note',
      content: 'Mine ',
      rev: 'rev-space',
    });

    expect(await queue.adoptRemoteContent('c1', 'n1')).toBe('kept-local');

    expect(dismissMock).not.toHaveBeenCalled();
    expect(state.nodes[0].data.content).toBe('Mine');
    expect(queue.unsavedNodeIds('c1')).toEqual(['n1']);
    await queue.flushNow('c1', 'n1').catch(() => undefined);
    expect(putMock).not.toHaveBeenCalled();
  });

  it('is released by an update that carries the same content, not by one that differs', async () => {
    const { queue, state } = await freeze();
    const remote = (content: string) =>
      ({
        ...state.nodes[0],
        data: { ...state.nodes[0].data, content },
      }) as Node;
    expect(
      queue.settleConflictIfIdentical(
        remote('Mine.'),
        nodeRevisionOf({ content: 'Mine.' }),
      ),
    ).toBe(false);
    expect(queue.unsavedNodeIds('c1')).toEqual(['n1']);
    expect(dismissMock).not.toHaveBeenCalled();

    expect(
      queue.settleConflictIfIdentical(
        remote('Mine'),
        nodeRevisionOf({ content: 'Mine' }),
      ),
    ).toBe(true);
    expect(dismissMock).toHaveBeenCalledWith('conflict-toast');
    expect(queue.unsavedNodeIds('c1')).toEqual([]);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });
});
