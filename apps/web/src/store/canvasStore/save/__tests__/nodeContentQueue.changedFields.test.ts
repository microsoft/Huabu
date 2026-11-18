// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * A content save carries what this page changed since its baseline and
 * nothing else: the server keeps every field a request leaves out, so a
 * title, summary or body another writer changed meanwhile is not written
 * back from this page's copy.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import { CanvasConflictError, putNodeContent } from '@/api/canvas';
import { toast } from '@/components/Common/Toast';

import { createNodeContentQueue } from '../nodeContentQueue';

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

const node = (type: string, data: Record<string, unknown>): Node =>
  ({ id: 'n1', type, position: { x: 0, y: 0 }, data }) as Node;

function makeQueue(initial: Node, loaded = true) {
  const state = {
    canvasId: 'c1',
    isLoading: false,
    nodes: [initial] as Node[],
    _setStateRaw: vi.fn((partial: { nodes: Node[] }) => {
      state.nodes = partial.nodes;
    }),
    patchNodeSilent: vi.fn(),
  };
  const queue = createNodeContentQueue({
    delayMs: 0,
    getState: () => state,
    pageId: 'page-b',
  });
  // A node the page loaded has the server's revision as its baseline.
  if (loaded) queue.setBaselines([initial], { n1: 'rev-0' });
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
  return { queue, state, edit, sent };
}

const NOTE = {
  content: 'body',
  label: 'Title',
  labelSource: 'user',
  summary: 'summary',
  keywords: ['k'],
  provenance: { blocks: [] },
  properties: { Year: 2024 },
};

beforeEach(() => {
  putMock.mockReset();
  toastMock.mockClear();
  putMock.mockResolvedValue({ nodeId: 'n1', label: 'Title', rev: 'rev-1' });
});

describe('what a content save carries', () => {
  it('is the body alone, with the revision it was typed on, when only the body changed', async () => {
    const { queue, edit, sent } = makeQueue(node('note', NOTE));
    edit({ content: 'typed' });
    await queue.flushAll();
    expect(sent()).toEqual([
      {
        nodeType: 'note',
        content: 'typed',
        expectRev: 'rev-0',
        pageId: 'page-b',
      },
    ]);
  });

  it('is the title with its source when the node was renamed, and not the body', async () => {
    const { queue, edit, sent } = makeQueue(node('note', NOTE));
    edit({ label: 'Renamed' });
    await queue.flushAll();
    // The source is unchanged here and still travels with the title: the
    // server tells a person's title from an automatic one by it.
    expect(sent()).toEqual([
      {
        nodeType: 'note',
        label: 'Renamed',
        labelSource: 'user',
        expectRev: 'rev-0',
        pageId: 'page-b',
      },
    ]);
  });

  it('is the summary, keywords and provenance that were derived here, each only when it changed', async () => {
    const { queue, edit, sent } = makeQueue(node('note', NOTE));
    edit({ summary: 'new summary', keywords: ['k', 'l'] });
    await queue.flushAll();
    edit({ provenance: { blocks: [1] } });
    await queue.flushAll();
    expect(sent()).toEqual([
      {
        nodeType: 'note',
        summary: 'new summary',
        keywords: ['k', 'l'],
        expectRev: 'rev-0',
        pageId: 'page-b',
      },
      {
        nodeType: 'note',
        provenance: { blocks: [1] },
        expectRev: 'rev-1',
        pageId: 'page-b',
      },
    ]);
  });

  it('carries a changed property beside a changed body as that one key', async () => {
    const { queue, edit, sent } = makeQueue(node('note', NOTE));
    edit({ content: 'typed', properties: { Year: 2025 } });
    await queue.flushAll();
    expect(sent()).toEqual([
      {
        nodeType: 'note',
        content: 'typed',
        properties: { Year: 2025 },
        expectRev: 'rev-0',
        pageId: 'page-b',
      },
    ]);
  });

  it('sends nothing when nothing was changed here', async () => {
    const { queue, sent } = makeQueue(node('note', NOTE));
    await queue.flushNow('c1', 'n1');
    expect(sent()).toEqual([]);
    expect(queue.hasUnsaved('n1')).toBe(false);
  });

  it('is the whole node for a node this page has not saved yet', async () => {
    const created = node('note', NOTE);
    const { queue, sent } = makeQueue(created, false);
    queue.scheduleChanges('c1', [], [created]);
    await queue.flushAll();
    expect(sent()).toEqual([
      {
        nodeType: 'note',
        ...NOTE,
        expectRev: nodeRevisionOf({}),
        pageId: 'page-b',
      },
    ]);
  });

  it.each([
    ['pdf', { src: 'paper.pdf', label: 'Paper', labelSource: 'auto' }],
    ['office', { src: 'deck.pptx', content: 'slides', label: 'Deck' }],
    ['web', { src: 'https://example.com', content: 'page', label: 'Page' }],
  ])(
    'renames a %s without sending its file reference or derived text',
    async (type, data) => {
      const { queue, edit, sent } = makeQueue(node(type, data));
      edit({ label: 'Renamed', labelSource: 'user' });
      await queue.flushAll();
      expect(sent()).toEqual([
        {
          nodeType: type,
          label: 'Renamed',
          labelSource: 'user',
          expectRev: 'rev-0',
          pageId: 'page-b',
        },
      ]);
    },
  );

  it('saves text a PDF was given by preprocessing on this page as that text alone', async () => {
    const { queue, edit, sent } = makeQueue(
      node('pdf', { src: 'paper.pdf', label: 'Paper' }),
    );
    edit({ content: 'extracted', summary: 'about' });
    await queue.flushAll();
    expect(sent()).toEqual([
      {
        nodeType: 'pdf',
        content: 'extracted',
        summary: 'about',
        expectRev: 'rev-0',
        pageId: 'page-b',
      },
    ]);
  });

  it('sends only the prompt of a Question whose prompt was typed, as before', async () => {
    const { queue, edit, sent } = makeQueue(
      node('question', { content: '', label: 'Question 1', threadId: 't' }),
    );
    edit({ content: 'Why?' });
    await queue.flushAll();
    expect(sent()).toEqual([
      {
        nodeType: 'question',
        content: 'Why?',
        expectRev: 'rev-0',
        pageId: 'page-b',
      },
    ]);
  });
});

describe('Keep mine after a body conflict', () => {
  it('resends the body alone on the server’s revision: a title another writer gave the node meanwhile is not in the request', async () => {
    const { queue, edit, sent } = makeQueue(node('note', NOTE));
    edit({ content: 'mine' });
    putMock.mockRejectedValueOnce(
      new CanvasConflictError({
        code: 'NODE_CONTENT_CONFLICT',
        message: 'changed elsewhere',
        nodeId: 'n1',
        currentRev: 'rev-theirs',
      }),
    );
    await queue.flushAll();
    expect(sent()).toHaveLength(1);

    const keepMine = toastMock.mock.calls.find(
      ([, options]) => options?.secondaryAction,
    )?.[1].secondaryAction.onClick as () => void;
    keepMine();
    await vi.waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]).toEqual({
      nodeType: 'note',
      content: 'mine',
      expectRev: 'rev-theirs',
      pageId: 'page-b',
    });
  });

  it('also resends a title this page changed itself: that is its own unsaved change', async () => {
    const { queue, edit, sent } = makeQueue(node('note', NOTE));
    edit({ content: 'mine', label: 'My title' });
    putMock.mockRejectedValueOnce(
      new CanvasConflictError({
        code: 'NODE_CONTENT_CONFLICT',
        message: 'changed elsewhere',
        nodeId: 'n1',
        currentRev: 'rev-theirs',
      }),
    );
    await queue.flushAll();
    const keepMine = toastMock.mock.calls.find(
      ([, options]) => options?.secondaryAction,
    )?.[1].secondaryAction.onClick as () => void;
    keepMine();
    await vi.waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]).toEqual({
      nodeType: 'note',
      content: 'mine',
      label: 'My title',
      labelSource: 'user',
      expectRev: 'rev-theirs',
      pageId: 'page-b',
    });
  });
});
