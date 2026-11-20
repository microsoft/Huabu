// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * A title a person gave is an independent small item, like a custom
 * property: a rename quotes no revision, is never refused because the body
 * changed, and its answer never moves the body's baseline. What is derived
 * from one particular body (summary, keywords, provenance, an automatic
 * title) still quotes the body's revision.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { CanvasConflictError, putNodeContent } from '@/api/canvas';
import { toast } from '@/components/Common/Toast';

import { createNodeContentQueue } from '../nodeContentQueue';
import { unsavedFields } from './unsavedFields';

import type * as CanvasApi from '@/api/canvas';
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
const toastMock = toast as unknown as Mock;

const NOTE = {
  content: 'body',
  label: 'Title',
  labelSource: 'auto',
  summary: 'summary',
  properties: { Year: 2024 },
};

function makeQueue(data: Record<string, unknown> = NOTE) {
  const initial = {
    id: 'n1',
    type: 'note',
    position: { x: 0, y: 0 },
    data,
  } as Node;
  const state = {
    canvasId: 'c1',
    isLoading: false,
    nodes: [initial] as Node[],
    _setStateRaw: vi.fn((partial: { nodes: Node[] }) => {
      state.nodes = partial.nodes;
    }),
    patchNodeSilent: vi.fn(),
  };
  const holdsEnded: string[][] = [];
  const queue = createNodeContentQueue({
    delayMs: 0,
    getState: () => state,
    pageId: 'page-b',
    onHoldsEnded: (_canvasId, _nodeId, saved) =>
      holdsEnded.push(
        ['content', 'label', 'labelSource', 'summary'].filter(saved),
      ),
  });
  queue.setBaselines([initial], { n1: 'rev-0' });
  /** The person changes fields of the node on this page. */
  const edit = (patch: Record<string, unknown>) => {
    const prev = state.nodes;
    state.nodes = prev.map((item) => ({
      ...item,
      data: { ...item.data, ...patch },
    }));
    queue.scheduleChanges('c1', prev, state.nodes);
  };
  const sent = () =>
    putMock.mock.calls.map(([, , body]) => body as Record<string, unknown>);
  const label = () => state.nodes[0]?.data['label'];
  return { queue, state, edit, sent, label, holdsEnded };
}

const stale = (extra: { titleApplied?: boolean } = {}) =>
  new CanvasConflictError({
    code: 'NODE_CONTENT_CONFLICT',
    message: 'changed elsewhere',
    nodeId: 'n1',
    currentRev: 'rev-theirs',
    ...extra,
  });

const conflictToasts = () =>
  toastMock.mock.calls.filter(([, options]) => options?.secondaryAction);

beforeEach(() => {
  putMock.mockReset();
  toastMock.mockClear();
  putMock.mockResolvedValue({ nodeId: 'n1', label: 'Title', rev: 'rev-1' });
});

describe('a rename', () => {
  it('quotes no revision, and its answer does not move the baseline of the body', async () => {
    const { queue, edit, sent } = makeQueue();
    // The answer names the revision of the body the server holds. Another
    // page may have saved that body and this page not fetched it yet.
    putMock.mockResolvedValueOnce({
      nodeId: 'n1',
      label: 'Renamed',
      rev: 'rev-of-a-body-this-page-never-showed',
    });
    edit({ label: 'Renamed', labelSource: 'user' });
    await queue.flushAll();
    expect(sent()).toEqual([
      {
        nodeType: 'note',
        label: 'Renamed',
        labelSource: 'user',
        pageId: 'page-b',
      },
    ]);
    expect(queue.hasUnsavedContent('c1')).toBe(false);
    expect(unsavedFields(queue, 'n1')).toEqual([]);

    // The body typed next is saved on the revision this page showed, so the
    // server refuses it if somebody else's body is there.
    edit({ content: 'typed' });
    await queue.flushAll();
    expect(sent()[1]).toEqual({
      nodeType: 'note',
      content: 'typed',
      expectRev: 'rev-0',
      pageId: 'page-b',
    });
  });

  it('is settled by its answer: the title is no longer held and what was kept back for it is dropped', async () => {
    const { queue, edit, holdsEnded } = makeQueue();
    edit({ label: 'Renamed', labelSource: 'user' });
    expect(queue.holdsUnit('n1', 'data.label')).toBe(true);
    await queue.flushAll();
    expect(queue.holdsUnit('n1', 'data.label')).toBe(false);
    expect(holdsEnded).toEqual([['label', 'labelSource']]);
  });

  it('shows the title the server stored when it differs from the one sent', async () => {
    const { queue, edit, label } = makeQueue();
    putMock.mockResolvedValueOnce({
      nodeId: 'n1',
      label: 'Renamed (2)',
      rev: 'rev-0',
    });
    edit({ label: 'Renamed', labelSource: 'agent' });
    await queue.flushAll();
    expect(label()).toBe('Renamed (2)');
  });

  it('typed while the body is unsaved travels with the body, which quotes its revision', async () => {
    const { queue, edit, sent } = makeQueue();
    edit({ content: 'typed', label: 'Renamed', labelSource: 'user' });
    await queue.flushAll();
    expect(sent()).toEqual([
      {
        nodeType: 'note',
        content: 'typed',
        label: 'Renamed',
        labelSource: 'user',
        expectRev: 'rev-0',
        pageId: 'page-b',
      },
    ]);
  });

  it('is kept when the body beside it is refused: the server wrote the title, and Keep mine sends the body alone', async () => {
    const { queue, edit, sent, label } = makeQueue();
    edit({ content: 'mine', label: 'Renamed', labelSource: 'user' });
    putMock.mockRejectedValueOnce(stale({ titleApplied: true }));
    await queue.flushAll();

    // The body is the user's to answer; the rename is done.
    expect(conflictToasts()).toHaveLength(1);
    expect(label()).toBe('Renamed');
    expect(unsavedFields(queue, 'n1')).toEqual(['content']);

    const keepMine = conflictToasts()[0]?.[1].secondaryAction
      .onClick as () => void;
    keepMine();
    await vi.waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]).toEqual({
      nodeType: 'note',
      content: 'mine',
      expectRev: 'rev-theirs',
      pageId: 'page-b',
    });
  });

  it('of a node frozen by a body conflict is sent by itself, without a revision, and leaves the conflict open', async () => {
    const { queue, edit, sent } = makeQueue();
    edit({ content: 'mine' });
    putMock.mockRejectedValueOnce(stale());
    await queue.flushAll();
    expect(conflictToasts()).toHaveLength(1);

    edit({ label: 'Renamed', labelSource: 'user' });
    await queue.flushNow('c1', 'n1');
    expect(sent()[1]).toEqual({
      nodeType: 'note',
      label: 'Renamed',
      labelSource: 'user',
      pageId: 'page-b',
    });
    // The body is still unsaved and still the user's to answer.
    expect(unsavedFields(queue, 'n1')).toEqual(['content']);
    expect(queue.hasUnsavedContent('c1')).toBe(true);
    expect(conflictToasts()).toHaveLength(1);
  });

  it('is not sent by itself for a node this page is still creating: its record is sent whole', async () => {
    const { queue, state, sent } = makeQueue();
    const created = {
      id: 'n2',
      type: 'note',
      position: { x: 0, y: 0 },
      data: { content: 'new', label: 'New note', labelSource: 'user' },
    } as Node;
    const prev = state.nodes;
    state.nodes = [...prev, created];
    queue.scheduleChanges('c1', prev, state.nodes);
    // Somebody else's record is already there: the creation is refused.
    putMock.mockRejectedValueOnce(stale());
    await queue.flushAll();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ content: 'new', label: 'New note' });
    expect(sent()[0]).toHaveProperty('expectRev');
    // Nothing more goes out until the user has answered.
    await queue.flushNow('c1', 'n2');
    expect(sent()).toHaveLength(1);
  });

  it('refused for a name another node uses is thrown to the caller, also for a frozen node', async () => {
    const { queue, edit } = makeQueue();
    edit({ label: 'Taken', labelSource: 'user' });
    const taken = new CanvasConflictError({
      code: 'NODE_LABEL_CONFLICT',
      message: 'in use',
      nodeId: 'n1',
      conflictWith: 'Taken',
    });
    putMock.mockRejectedValueOnce(taken);
    await expect(queue.flushNow('c1', 'n1')).rejects.toBe(taken);
  });
});

describe('what is derived from a body', () => {
  it('quotes the revision of that body: a summary, and an automatic title', async () => {
    const { queue, edit, sent } = makeQueue();
    edit({ summary: 'derived here' });
    await queue.flushAll();
    edit({ label: 'Derived title', labelSource: 'auto' });
    await queue.flushAll();
    expect(sent()).toEqual([
      {
        nodeType: 'note',
        summary: 'derived here',
        expectRev: 'rev-0',
        pageId: 'page-b',
      },
      {
        nodeType: 'note',
        label: 'Derived title',
        labelSource: 'auto',
        expectRev: 'rev-1',
        pageId: 'page-b',
      },
    ]);
  });

  it('is refused with the body’s conflict when the body changed, and a rename beside it is not', async () => {
    const { queue, edit, label } = makeQueue();
    edit({ summary: 'derived here', label: 'Renamed', labelSource: 'user' });
    putMock.mockRejectedValueOnce(stale({ titleApplied: true }));
    await queue.flushAll();
    expect(label()).toBe('Renamed');
    // The freeze holds the body's fields; the summary is still unsaved; the
    // title is not.
    expect(unsavedFields(queue, 'n1')).toEqual(['content', 'summary']);
  });

  it('is not sent for a node frozen by a body conflict', async () => {
    const { queue, edit, sent } = makeQueue();
    edit({ content: 'mine' });
    putMock.mockRejectedValueOnce(stale());
    await queue.flushAll();
    edit({ label: 'Derived title', labelSource: 'auto' });
    await queue.flushNow('c1', 'n1');
    expect(sent()).toHaveLength(1);
  });
});
