// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  postCanvasExecute: vi.fn(),
  getCanvas: vi.fn(),
  putNodeContent: vi.fn(),
  getNodeContent: vi.fn(),
  preprocessNode: vi.fn(),
  postCanvasEvents: vi.fn(),
}));
vi.mock('../api', async (actual) => ({
  ...(await actual<typeof apiModule>()),
  ...api,
}));
vi.mock('../api/canvas', async (actual) => ({
  ...(await actual<typeof canvasApiModule>()),
  ...api,
}));
vi.mock('@/components/Common/Toast', () => ({
  toast: vi.fn(() => 'toast-id'),
  dismissToast: vi.fn(),
}));

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import { dismissToast, toast } from '@/components/Common/Toast';

import { canvasHistoryManager } from './canvasHistoryManager';
import { CanvasConflictError } from '../api/canvas';
import { useCanvasPresenceStore } from './canvasPresence/canvasPresenceStore';
import useCanvasStore, {
  adoptRemoteNodeContent,
  commitNodeProperties,
  hasUnsavedCanvasEdits,
  resetCanvasSyncForTests,
} from './canvasStore';
import { CANVAS_PAGE_ID } from './canvasStore/sync/pageId';
import { contentRevisionsOf } from './canvasStore/sync/testing/contentRevisions';
import { createFakeSpaceServer } from './canvasStore/sync/testing/fakeExecuteServer';

import type * as apiModule from '../api';
import type * as canvasApiModule from '../api/canvas';
import type { Node } from '@xyflow/react';

/**
 * The real store receives content another page saved. What must not follow
 * on the receiving page: a save, an undo entry, a preprocessing run, or a
 * change to selection.
 */

const SPACE = 'space-remote-content';
const X = 'node-content-x';
const Y = 'node-content-y';

const note = (id: string, x: number): Node => ({
  id,
  type: 'note',
  position: { x, y: 0 },
  style: { width: 300, height: 200 },
  data: {
    type: 'note',
    label: `Label ${id}`,
    content: `Body ${id}`,
    heightMode: 'fixed',
    style: { accent: 'white' },
  },
});

const state = () => useCanvasStore.getState();
const node = (id: string): Node => {
  const found = state().nodes.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing node ${id}`);
  return found;
};
const savedOnServer = (content: string, label: string) => ({
  nodeId: X,
  type: 'note',
  label,
  content,
  rev: nodeRevisionOf({ content }),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetCanvasSyncForTests();
  const nodes = [{ ...note(X, 0), selected: true }, note(Y, 400)];
  canvasHistoryManager.activate(SPACE, true);
  state()._setStateRaw({
    canvasId: SPACE,
    canvasTitle: 'Content',
    nodes,
    edges: [],
    version: 1,
    isLoading: false,
    canUndo: false,
    canRedo: false,
  });
  api.postCanvasExecute.mockImplementation(() => new Promise(() => {}));
  api.putNodeContent.mockImplementation(
    async (_canvasId: string, nodeId: string, body: { content?: string }) => ({
      nodeId,
      label: null,
      rev: nodeRevisionOf({ content: body.content ?? '' }),
    }),
  );
  api.preprocessNode.mockResolvedValue({ success: true });
  api.postCanvasEvents.mockResolvedValue({ success: true });
  // The content queue outlives a test; a fetch it still owes finds nothing.
  api.getNodeContent.mockReset();
  api.getNodeContent.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('content another page saved, in the store', () => {
  it('is shown without a save, an undo entry, a preprocessing run or a selection change', async () => {
    api.getNodeContent.mockResolvedValue(
      savedOnServer('Body from A', 'From A'),
    );
    const other = node(Y);

    await expect(adoptRemoteNodeContent(SPACE, [X])).resolves.toEqual([
      'applied',
    ]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(node(X).data).toMatchObject({
      content: 'Body from A',
      label: 'From A',
      style: { accent: 'white' },
    });
    expect(node(X).selected).toBe(true);
    expect(node(X).position).toEqual({ x: 0, y: 0 });
    expect(node(Y)).toBe(other);
    expect(state().canUndo).toBe(false);
    expect(canvasHistoryManager.canUndo).toBe(false);
    expect(state().pendingContentNodeIds()).toEqual([]);
    expect(hasUnsavedCanvasEdits()).toBe(false);
    expect(api.putNodeContent).not.toHaveBeenCalled();
    expect(api.postCanvasExecute).not.toHaveBeenCalled();
    expect(api.preprocessNode).not.toHaveBeenCalled();
  });

  it("sends this page's next edit of the node from the adopted revision, naming the page", async () => {
    api.getNodeContent.mockResolvedValue(
      savedOnServer('Body from A', 'From A'),
    );
    await adoptRemoteNodeContent(SPACE, [X]);

    state().updateNodeData(X, { content: 'Body from A, then B' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(api.putNodeContent).toHaveBeenCalledTimes(1);
    // The body this page changed, and nothing it did not.
    expect(api.putNodeContent.mock.calls[0][2]).toEqual({
      nodeType: 'note',
      content: 'Body from A, then B',
      expectRev: nodeRevisionOf({ content: 'Body from A' }),
      pageId: CANVAS_PAGE_ID,
    });
  });

  it('is not put back, or saved over, by undoing an earlier local edit', async () => {
    // This page recolours X; that is its undo entry.
    state().executeCommands([
      {
        type: 'MERGE_NODE_DATA',
        patches: [
          {
            nodeId: X as `node-${string}`,
            patch: { style: { accent: 'red' } },
          },
        ],
      },
    ]);
    expect(state().canUndo).toBe(true);
    api.getNodeContent.mockResolvedValue(
      savedOnServer('Body from A', 'From A'),
    );
    await adoptRemoteNodeContent(SPACE, [X]);

    state().undo();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(node(X).data).toMatchObject({
      content: 'Body from A',
      label: 'From A',
      style: { accent: 'white' },
    });
    expect(api.putNodeContent).not.toHaveBeenCalled();

    state().redo();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(node(X).data).toMatchObject({
      content: 'Body from A',
      style: { accent: 'red' },
    });
    expect(api.putNodeContent).not.toHaveBeenCalled();
  });

  it('comes back with the node when this page deletes it and undoes the deletion', async () => {
    // This case needs the server to answer: the restore follows the delete.
    const server = createFakeSpaceServer();
    server.reset(state().nodes, [], 1);
    api.postCanvasExecute.mockImplementation(async (canvasId, request) =>
      server.execute(canvasId, request),
    );
    // An entry taken while X still had its first body.
    state().executeCommands([
      {
        type: 'MERGE_NODE_DATA',
        patches: [
          {
            nodeId: X as `node-${string}`,
            patch: { style: { accent: 'red' } },
          },
        ],
      },
    ]);
    api.getNodeContent.mockResolvedValue(
      savedOnServer('Body from A', 'From A'),
    );
    await adoptRemoteNodeContent(SPACE, [X]);

    state().deleteNodes([X]);
    expect(state().nodes.map((n) => n.id)).toEqual([Y]);
    state().undo();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(node(X).data).toMatchObject({
      content: 'Body from A',
      label: 'From A',
    });
    // The restoring batch carries the adopted body, not the entry's first.
    const restored = server.requests
      .flatMap(
        (request) =>
          request.edits.flatMap((edit) => edit.commands) as Array<{
            type: string;
            nodes?: Node[];
          }>,
      )
      .filter((command) => command.type === 'RESTORE_NODES')
      .flatMap((command) => command.nodes ?? [])
      .filter((restoredNode) => restoredNode.id === X);
    expect(restored.map((restoredNode) => restoredNode.data.content)).toEqual([
      'Body from A',
    ]);
    expect(
      server.state.nodes.find((serverNode) => serverNode.id === X)?.data
        .content,
    ).toBe('Body from A');
    expect(api.putNodeContent).not.toHaveBeenCalled();
    expect(hasUnsavedCanvasEdits()).toBe(false);
  });

  it('leaves the body of a node this page is still saving exactly as typed, and shows the title the other page gave it', async () => {
    state().updateNodeData(X, { content: 'Typed on this page' });
    api.getNodeContent.mockResolvedValue(
      savedOnServer('Body from A', 'From A'),
    );

    await expect(adoptRemoteNodeContent(SPACE, [X])).resolves.toEqual([
      'kept-local',
    ]);

    // The body is this page's until it is saved; the title is not held.
    expect(api.getNodeContent).toHaveBeenCalledTimes(1);
    expect(node(X).data).toMatchObject({
      content: 'Typed on this page',
      label: 'From A',
    });
    expect(api.putNodeContent).not.toHaveBeenCalled();
  });
});

describe('a body typed on this page while an update for another node arrives', () => {
  it('is saved from the revision the server holds, not from its own', async () => {
    // The queue outlives a test: start from what the server holds.
    api.getNodeContent.mockResolvedValue({
      ...savedOnServer(`Body ${Y}`, `Label ${Y}`),
      nodeId: Y,
    });
    await adoptRemoteNodeContent(SPACE, [Y]);
    state().updateNodeData(Y, { content: 'Typed while X moved' });
    // Another page moved X before this page's save was sent.
    const moved = { ...node(X), position: { x: 400, y: 300 } };
    state().applyServerDeltas(
      [{ type: 'REPLACE_NODE', prev: node(X), next: moved }] as never,
      2,
      {
        mutatedNodeIds: [],
        deletedNodeIds: [],
        contentEditedNodeIds: [],
        deferredFitFrameIds: [],
      } as never,
      undefined,
      undefined,
      { source: 'ui' },
    );
    expect(node(X).position).toEqual({ x: 400, y: 300 });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(api.putNodeContent).toHaveBeenCalledTimes(1);
    expect(api.putNodeContent.mock.calls[0][2]).toMatchObject({
      content: 'Typed while X moved',
      expectRev: nodeRevisionOf({ content: `Body ${Y}` }),
    });
  });
});

describe('properties another page saved', () => {
  const withProperties = (
    properties?: Record<string, string | string[]>,
    propertyDisplayKeys?: string[],
  ) => ({
    ...savedOnServer(`Body ${Z}`, `Label ${Z}`),
    nodeId: Z,
    ...(properties ? { properties } : {}),
    ...(propertyDisplayKeys ? { propertyDisplayKeys } : {}),
    rev: nodeRevisionOf({
      content: `Body ${Z}`,
      ...(properties ? { properties } : {}),
      ...(propertyDisplayKeys ? { propertyDisplayKeys } : {}),
    }),
  });

  // The content queue outlives a test and other cases leave X unsaved, so
  // these use a node of their own, one per case.
  let Z: string;
  let cases = 0;
  beforeEach(() => {
    Z = `node-content-z${++cases}`;
    state()._setStateRaw({ nodes: [...state().nodes, note(Z, 800)] });
  });

  it('are shown with their display order, without a save or an undo entry', async () => {
    api.getNodeContent.mockResolvedValue(
      withProperties({ tags: ['draft', 'physics'], status: 'read' }, ['tags']),
    );

    await expect(adoptRemoteNodeContent(SPACE, [Z])).resolves.toEqual([
      'applied',
    ]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(node(Z).data).toMatchObject({
      content: `Body ${Z}`,
      properties: { tags: ['draft', 'physics'], status: 'read' },
      propertyDisplayKeys: ['tags'],
    });
    expect(canvasHistoryManager.canUndo).toBe(false);
    expect(api.putNodeContent).not.toHaveBeenCalled();
    expect(api.postCanvasExecute).not.toHaveBeenCalled();
  });

  it('are removed here when the other page removed the last of them', async () => {
    api.getNodeContent.mockResolvedValue(
      withProperties({ status: 'read' }, ['status']),
    );
    await adoptRemoteNodeContent(SPACE, [Z]);
    expect(node(Z).data.properties).toEqual({ status: 'read' });

    api.getNodeContent.mockResolvedValue(withProperties());
    await expect(adoptRemoteNodeContent(SPACE, [Z])).resolves.toEqual([
      'applied',
    ]);

    expect(node(Z).data).not.toHaveProperty('properties');
    expect(node(Z).data).not.toHaveProperty('propertyDisplayKeys');
    expect(api.putNodeContent).not.toHaveBeenCalled();
  });

  it('shows the tag another page added while a body is being typed here, and saves that body without a prompt', async () => {
    // The page shows what the server holds, and knows its revision.
    api.getNodeContent.mockResolvedValue(withProperties());
    await adoptRemoteNodeContent(SPACE, [Z]);
    state().updateNodeData(Z, { content: 'Typed on this page' });
    // The other page changed a property; the body is as this page loaded it.
    api.getNodeContent.mockResolvedValue(
      withProperties({ tags: ['physics'] }, ['tags']),
    );
    await expect(adoptRemoteNodeContent(SPACE, [Z])).resolves.toEqual([
      'kept-local',
    ]);
    expect(node(Z).data).toMatchObject({
      content: 'Typed on this page',
      properties: { tags: ['physics'] },
      propertyDisplayKeys: ['tags'],
    });

    // The server accepts a body save only on the revision it holds, which
    // the property change did not move.
    api.putNodeContent.mockImplementation(
      async (
        _canvasId: string,
        nodeId: string,
        body: { expectRev?: string },
      ) => {
        if (body.expectRev !== nodeRevisionOf({ content: `Body ${Z}` }))
          throw new CanvasConflictError({
            code: 'NODE_CONTENT_CONFLICT',
            message: 'changed elsewhere',
            nodeId,
          });
        return { nodeId, label: null, rev: 'after-typing' };
      },
    );
    api.getNodeContent.mockResolvedValue({
      ...withProperties({ tags: ['physics'] }, ['tags']),
      content: 'Typed on this page',
      rev: 'after-typing',
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(api.putNodeContent).toHaveBeenCalledTimes(1);
    const sent = api.putNodeContent.mock.calls[0][2];
    expect(sent.content).toBe('Typed on this page');
    expect(sent).not.toHaveProperty('properties');
    expect(toast).not.toHaveBeenCalled();
    expect(state().pendingContentNodeIds()).not.toContain(Z);
    expect(node(Z).data).toMatchObject({
      content: 'Typed on this page',
      properties: { tags: ['physics'] },
    });
    expect(canvasHistoryManager.canUndo).toBe(true);
  });

  it("leave this page's edit of another property of the node standing: it is sent as that one key, without a revision", async () => {
    const theirs = withProperties({ status: 'read' });
    api.getNodeContent.mockResolvedValue(theirs);
    await adoptRemoteNodeContent(SPACE, [Z]);

    await expect(
      commitNodeProperties(Z, { properties: { tags: ['mine'] } }),
    ).resolves.toBe(true);

    expect(api.putNodeContent).toHaveBeenCalledTimes(1);
    const sent = api.putNodeContent.mock.calls[0][2];
    expect(sent).not.toHaveProperty('expectRev');
    expect(sent.pageId).toBe(CANVAS_PAGE_ID);
    // Their key is not in the request at all: the server keeps it.
    expect(sent.properties).toEqual({ tags: ['mine'] });
    expect(node(Z).data.properties).toEqual({
      status: 'read',
      tags: ['mine'],
    });
  });

  it("are fetched and shown while this page's own save of another property is in flight, and read once more when it is answered", async () => {
    let answer!: (value: unknown) => void;
    api.putNodeContent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const saving = commitNodeProperties(Z, { properties: { tags: ['mine'] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.putNodeContent).toHaveBeenCalledTimes(1);

    // A property save on the wire is not unsaved content of the node: the
    // other page's save is shown at once. (This fetch read the server
    // before this page's patch was written.)
    api.getNodeContent.mockResolvedValue(withProperties({ status: 'read' }));
    await expect(adoptRemoteNodeContent(SPACE, [Z])).resolves.toEqual([
      'applied',
    ]);
    expect(api.getNodeContent).toHaveBeenCalledTimes(1);
    expect(node(Z).data.properties).toEqual({ status: 'read' });

    api.getNodeContent.mockResolvedValue(
      withProperties({ status: 'read', tags: ['mine'] }),
    );
    answer({ nodeId: Z, label: `Label ${Z}`, rev: 'after-mine' });
    await expect(saving).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    // One more read, since properties arrived while the save was under way.
    expect(api.getNodeContent).toHaveBeenCalledTimes(2);
    expect(node(Z).data.properties).toEqual({
      status: 'read',
      tags: ['mine'],
    });
    expect(api.putNodeContent).toHaveBeenCalledTimes(1);
    expect(state().pendingContentNodeIds()).not.toContain(Z);
  });
});

describe('the revision of a node whose stored body the page does not show', () => {
  it('is kept through a structure update: a summary save of a PDF quotes it, and a property save and a rename quote none', async () => {
    // A load brings the server's revision of the PDF; the page is not sent
    // the extracted text it is computed from.
    const PDF = 'node-content-pdf';
    const pdf: Node = {
      id: PDF,
      type: 'pdf',
      position: { x: 800, y: 0 },
      style: { width: 300, height: 400 },
      data: { type: 'pdf', label: 'Paper', src: 'paper.pdf' },
    };
    const canonical = nodeRevisionOf({
      type: 'pdf',
      content: 'Extracted text the page never received',
      src: 'paper.pdf',
    });
    api.getCanvas.mockResolvedValue({
      canvasId: SPACE,
      title: 'Content',
      version: 1,
      access: { write: true, manage: true },
      nodeContentRevisions: { [PDF]: canonical },
      state: { nodes: [note(X, 0), note(Y, 400), pdf], edges: [] },
    });
    await state().loadCanvas(SPACE);
    await vi.advanceTimersByTimeAsync(0);
    expect(node(PDF).data).not.toHaveProperty('content');

    // Another page moves the PDF, and yet another node.
    for (const [index, id] of [PDF, X].entries()) {
      const moved = { ...node(id), position: { x: 40 * index, y: 300 } };
      state().applyServerDeltas(
        [{ type: 'REPLACE_NODE', prev: node(id), next: moved }] as never,
        state().version + 1,
        {
          mutatedNodeIds: [],
          deletedNodeIds: [],
          contentEditedNodeIds: [],
          deferredFitFrameIds: [],
        } as never,
        undefined,
        undefined,
        { source: 'ui' },
      );
    }
    expect(node(PDF).position).toEqual({ x: 0, y: 300 });

    await expect(
      commitNodeProperties(PDF, { properties: { tags: ['physics'] } }),
    ).resolves.toBe(true);
    expect(api.putNodeContent).toHaveBeenCalledTimes(1);
    expect(api.putNodeContent.mock.calls[0][2]).toMatchObject({
      properties: { tags: ['physics'] },
    });
    expect(api.putNodeContent.mock.calls[0][2]).not.toHaveProperty('expectRev');

    // A rename quotes no revision either.
    state().updateNodeData(PDF, { label: 'Paper, final', labelSource: 'user' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.putNodeContent).toHaveBeenCalledTimes(2);
    expect(api.putNodeContent.mock.calls[1][2]).toMatchObject({
      label: 'Paper, final',
    });
    expect(api.putNodeContent.mock.calls[1][2]).not.toHaveProperty('expectRev');

    // The baseline is still the load's: a save of something derived from
    // the body quotes it, not a hash of the node without its extracted
    // text, and not the revision the other saves' answers named.
    state().updateNodeData(PDF, { summary: 'A paper.' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.putNodeContent).toHaveBeenCalledTimes(3);
    expect(api.putNodeContent.mock.calls[2][2]).toMatchObject({
      summary: 'A paper.',
      expectRev: canonical,
    });
  });
});

describe("an agent's write to a PDF's properties and cover", () => {
  it('is shown, and the next property save here sends its own key and leaves what the agent wrote', async () => {
    const PDF = 'node-content-pdf-agent';
    const pdf: Node = {
      id: PDF,
      type: 'pdf',
      position: { x: 800, y: 0 },
      style: { width: 300, height: 400 },
      data: { type: 'pdf', label: 'Paper', src: 'paper.pdf' },
    };
    state()._setStateRaw({ nodes: [...state().nodes, pdf] });
    // The server's copy carries the extracted text the page does not show.
    const stored = {
      ...pdf,
      data: { ...pdf.data, content: 'Extracted text' },
    };
    const written = {
      ...stored,
      data: {
        ...stored.data,
        coverUrl: 'cover.png',
        properties: { year: 2026 },
        propertyDisplayKeys: ['year'],
      },
    };
    state().applyServerDeltas(
      [{ type: 'REPLACE_NODE', prev: stored, next: written }] as never,
      state().version + 1,
      {
        mutatedNodeIds: [],
        deletedNodeIds: [],
        contentEditedNodeIds: [],
        deferredFitFrameIds: [],
      } as never,
      undefined,
      undefined,
      {
        source: 'agent',
        // The server names the revision of what it stored for the PDF.
        nodeContentRevisions: contentRevisionsOf([
          { type: 'REPLACE_NODE', prev: stored, next: written },
        ] as never),
      },
    );
    expect(node(PDF).data).toMatchObject({
      coverUrl: 'cover.png',
      properties: { year: 2026 },
      propertyDisplayKeys: ['year'],
    });
    expect(node(PDF).data).not.toHaveProperty('content');
    expect(api.putNodeContent).not.toHaveBeenCalled();

    await expect(
      commitNodeProperties(PDF, { properties: { tags: ['physics'] } }),
    ).resolves.toBe(true);
    // Its own key, no revision; the agent's key is not sent back.
    expect(api.putNodeContent.mock.calls[0][2]).toEqual({
      nodeType: 'pdf',
      properties: { tags: ['physics'] },
      pageId: CANVAS_PAGE_ID,
    });

    // The agent clears the cover again; a page follows that too.
    const { coverUrl: _cleared, ...withoutCover } = written.data;
    void _cleared;
    state().applyServerDeltas(
      [
        {
          type: 'REPLACE_NODE',
          prev: written,
          next: { ...written, data: withoutCover },
        },
      ] as never,
      state().version + 1,
      {
        mutatedNodeIds: [],
        deletedNodeIds: [],
        contentEditedNodeIds: [],
        deferredFitFrameIds: [],
      } as never,
      undefined,
      undefined,
      { source: 'agent' },
    );
    expect(node(PDF).data).not.toHaveProperty('coverUrl');
    expect(node(PDF).data.properties).toEqual({
      year: 2026,
      tags: ['physics'],
    });
  });
});

describe("the revision an update brings for a node's content", () => {
  const noEffects = {
    mutatedNodeIds: [],
    deletedNodeIds: [],
    contentEditedNodeIds: [],
    deferredFitFrameIds: [],
  } as never;
  /** A revision no hash of the node in the update would give. */
  const STORED = 'stored-by-the-server';
  /** An agent's `update` that rewrites the body of `id`. */
  function agentWrites(
    id: string,
    content: string,
    nodeContentRevisions?: Record<string, string>,
  ) {
    const prev = {
      ...node(id),
      data: { ...node(id).data, content: `Body ${id}` },
    };
    const next = { ...prev, data: { ...prev.data, content } };
    return state().applyServerDeltas(
      [{ type: 'REPLACE_NODE', prev, next }] as never,
      state().version + 1,
      noEffects,
      undefined,
      undefined,
      {
        source: 'agent',
        ...(nodeContentRevisions ? { nodeContentRevisions } : {}),
      },
    );
  }
  /** The server accepts a save only on the revision it holds. */
  function serverHolds(rev: string) {
    api.putNodeContent.mockImplementation(
      async (
        _canvasId: string,
        nodeId: string,
        body: { expectRev?: string },
      ) => {
        if (body.expectRev !== rev)
          throw new CanvasConflictError({
            code: 'NODE_CONTENT_CONFLICT',
            message: 'changed elsewhere',
            nodeId,
            currentRev: rev,
          });
        return { nodeId, label: null, rev: `${rev}+1` };
      },
    );
  }
  const conflictToasts = () =>
    vi
      .mocked(toast)
      .mock.calls.filter(
        ([, options]) => options?.secondaryAction?.label === 'Keep mine',
      );

  beforeEach(async () => {
    // The page shows what the server holds for X.
    api.getNodeContent.mockResolvedValue(
      savedOnServer(`Body ${X}`, `Label ${X}`),
    );
    // The content queue outlives a test: forget what earlier ones left
    // unsaved for these nodes, the way a deletion does.
    const { nodes } = state();
    useCanvasStore.setState({ nodes: [], isLoading: false });
    await vi.advanceTimersByTimeAsync(10_000);
    state()._setStateRaw({ nodes });
    vi.clearAllMocks();
    api.postCanvasExecute.mockImplementation(() => new Promise(() => {}));
    expect(state().pendingContentNodeIds()).toEqual([]);
    await adoptRemoteNodeContent(SPACE, [X]);
    api.getNodeContent.mockClear();
    api.getNodeContent.mockResolvedValue(null);
  });

  afterEach(async () => {
    useCanvasStore.setState({ nodes: [], isLoading: false });
    await vi.advanceTimersByTimeAsync(10_000);
  });

  it('becomes the baseline of the next save, although the node in the update hashes differently', async () => {
    serverHolds(STORED);
    expect(agentWrites(X, 'Agent text', { [X]: STORED })).toEqual([]);
    expect(node(X).data.content).toBe('Agent text');
    expect(STORED).not.toBe(nodeRevisionOf({ content: 'Agent text' }));
    // Nothing is fetched: the update said what the server stored.
    expect(api.getNodeContent).not.toHaveBeenCalled();

    state().updateNodeData(X, { content: 'Agent text, edited' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(api.putNodeContent).toHaveBeenCalledTimes(1);
    expect(api.putNodeContent.mock.calls[0][2]).toMatchObject({
      content: 'Agent text, edited',
      expectRev: STORED,
    });
    expect(conflictToasts()).toHaveLength(0);
    expect(state().pendingContentNodeIds()).toEqual([]);
  });

  it('moves the baseline of a body being typed without touching the text, and the save is accepted', async () => {
    serverHolds(STORED);
    state().updateNodeData(X, { content: 'Typing' });

    expect(agentWrites(X, 'Agent text', { [X]: STORED })).toEqual([X]);
    expect(node(X).data.content).toBe('Typing');
    expect(api.getNodeContent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.putNodeContent).toHaveBeenCalledTimes(1);
    expect(api.putNodeContent.mock.calls[0][2]).toMatchObject({
      content: 'Typing',
      expectRev: STORED,
    });
    expect(conflictToasts()).toHaveLength(0);
    expect(state().pendingContentNodeIds()).toEqual([]);
  });

  it('keeps a failed save and its Retry through updates, and Retry then saves on the revision the update brought', async () => {
    const retryToasts = () =>
      vi
        .mocked(toast)
        .mock.calls.filter(([, options]) => options?.action?.label === 'Retry');
    api.putNodeContent.mockRejectedValueOnce(new Error('offline'));
    state().updateNodeData(X, { content: 'Typing' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.putNodeContent).toHaveBeenCalledTimes(1);
    expect(retryToasts()).toHaveLength(1);
    vi.mocked(dismissToast).mockClear();

    // An update to another node's content, then one that carries new
    // content for the node whose text could not be saved.
    expect(agentWrites(Y, 'Agent Y', { [Y]: 'stored-y' })).toEqual([]);
    expect(node(Y).data.content).toBe('Agent Y');
    serverHolds(STORED);
    expect(agentWrites(X, 'Agent text', { [X]: STORED })).toEqual([X]);

    // The text is still here and still unsaved: so is the failure.
    expect(node(X).data.content).toBe('Typing');
    expect(dismissToast).not.toHaveBeenCalled();
    expect(hasUnsavedCanvasEdits()).toBe(true);
    expect(state().pendingContentNodeIds()).toEqual([X]);

    retryToasts()[0][1]?.action?.onClick();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.putNodeContent.mock.calls.at(-1)?.[2]).toMatchObject({
      content: 'Typing',
      expectRev: STORED,
    });
    expect(dismissToast).toHaveBeenCalledWith('toast-id');
    expect(conflictToasts()).toHaveLength(0);
    expect(state().pendingContentNodeIds()).toEqual([]);
  });

  it('is not replaced by a hash when the update names none: the node is fetched and takes the fetched revision', async () => {
    serverHolds(STORED);
    api.getNodeContent.mockResolvedValue({
      nodeId: X,
      type: 'note',
      label: `Label ${X}`,
      content: 'Agent text',
      rev: STORED,
    });

    expect(agentWrites(X, 'Agent text')).toEqual([]);
    expect(node(X).data.content).toBe('Agent text');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.getNodeContent).toHaveBeenCalledExactlyOnceWith(SPACE, X);

    state().updateNodeData(X, { content: 'Agent text, edited' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.putNodeContent).toHaveBeenCalledTimes(1);
    expect(api.putNodeContent.mock.calls[0][2]).toMatchObject({
      content: 'Agent text, edited',
      expectRev: STORED,
    });
    expect(conflictToasts()).toHaveLength(0);
  });

  /** An agent's `update` that changes custom properties of `id`, and its body when given. */
  function agentTags(
    id: string,
    properties: Record<string, unknown>,
    options: { content?: string; rev: string },
  ) {
    const prev = {
      ...node(id),
      data: { ...node(id).data, content: `Body ${id}` },
    };
    delete (prev.data as Record<string, unknown>)['properties'];
    delete (prev.data as Record<string, unknown>)['propertyDisplayKeys'];
    const next = {
      ...prev,
      data: {
        ...prev.data,
        properties,
        propertyDisplayKeys: Object.keys(properties),
        ...(options.content !== undefined ? { content: options.content } : {}),
      },
    };
    return state().applyServerDeltas(
      [{ type: 'REPLACE_NODE', prev, next }] as never,
      state().version + 1,
      noEffects,
      undefined,
      undefined,
      { source: 'agent', nodeContentRevisions: { [id]: options.rev } },
    );
  }

  it('shows a property an agent changed while a body is being typed, keeps the text, and the body save is accepted without a prompt', async () => {
    // The property change does not move the revision the server holds.
    const rev = nodeRevisionOf({ content: `Body ${X}` });
    serverHolds(rev);
    state().updateNodeData(X, { content: 'Typing' });

    // Nothing was withheld: the row is applied beside the unsaved body.
    expect(agentTags(X, { tags: ['physics'] }, { rev })).toEqual([]);
    expect(node(X).data).toMatchObject({
      content: 'Typing',
      properties: { tags: ['physics'] },
      propertyDisplayKeys: ['tags'],
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.putNodeContent).toHaveBeenCalledTimes(1);
    const sent = api.putNodeContent.mock.calls[0][2];
    expect(sent).toMatchObject({ content: 'Typing', expectRev: rev });
    // The agent's tag is not sent back.
    expect(sent).not.toHaveProperty('properties');
    expect(sent).not.toHaveProperty('propertyDisplayKeys');
    expect(toast).not.toHaveBeenCalled();
    expect(node(X).data).toMatchObject({
      content: 'Typing',
      properties: { tags: ['physics'] },
    });
    expect(state().pendingContentNodeIds()).not.toContain(X);
  });

  it('shows the properties of an update whose body it withholds from a node being typed', async () => {
    serverHolds(STORED);
    state().updateNodeData(X, { content: 'Typing' });

    // The body is the overlap: reported as kept. The tag is not part of it.
    expect(
      agentTags(
        X,
        { tags: ['physics'] },
        { content: 'Agent text', rev: STORED },
      ),
    ).toEqual([X]);
    expect(node(X).data).toMatchObject({
      content: 'Typing',
      properties: { tags: ['physics'] },
      propertyDisplayKeys: ['tags'],
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.putNodeContent.mock.calls[0][2]).toMatchObject({
      content: 'Typing',
      expectRev: STORED,
    });
    expect(api.putNodeContent.mock.calls[0][2]).not.toHaveProperty(
      'properties',
    );
    expect(conflictToasts()).toHaveLength(0);
  });

  it('keeps a property key changed and not saved here, and shows the other keys of the update', async () => {
    const rev = nodeRevisionOf({ content: `Body ${X}` });
    // A store change of a property (an undo, say), still queued.
    state().updateNodeData(X, { properties: { status: 'mine' } });

    expect(
      agentTags(X, { status: 'theirs', tags: ['physics'] }, { rev }),
    ).toEqual([]);
    expect(node(X).data.properties).toEqual({
      status: 'mine',
      tags: ['physics'],
    });

    await vi.advanceTimersByTimeAsync(10_000);
    // This page's key goes out by itself and is the last writer of it.
    expect(api.putNodeContent).toHaveBeenCalledTimes(1);
    expect(api.putNodeContent.mock.calls[0][2]).toEqual({
      nodeType: 'note',
      properties: { status: 'mine' },
      pageId: CANVAS_PAGE_ID,
    });
    expect(toast).not.toHaveBeenCalled();
  });

  it("leaves the baseline of a body being typed alone when the update names none, so the refused save is the user's to answer", async () => {
    serverHolds(STORED);
    state().updateNodeData(X, { content: 'Typing' });

    expect(agentWrites(X, 'Agent text')).toEqual([X]);
    expect(node(X).data.content).toBe('Typing');
    // A node with unsaved text is not fetched over: it is read for its
    // custom properties only, and neither its text nor its baseline moves.
    expect(api.getNodeContent).toHaveBeenCalledTimes(1);
    expect(node(X).data.content).toBe('Typing');

    await vi.advanceTimersByTimeAsync(10_000);
    // The save quoted the revision the page had, not one it computed.
    expect(api.putNodeContent.mock.calls[0][2]).toMatchObject({
      content: 'Typing',
      expectRev: nodeRevisionOf({ content: `Body ${X}` }),
    });
    // The server's body differs from the typed one: the user is asked.
    expect(node(X).data.content).toBe('Typing');
    expect(conflictToasts()).toHaveLength(1);
  });
});

describe('renaming a node another page is editing', () => {
  const editedBy = (editingNodeIds: string[]) =>
    useCanvasPresenceStore.getState().applyEvent({
      op: 'update',
      page: {
        pageId: 'page-a',
        colorIndex: 0,
        label: 'Chrome · Mac',
        pointer: null,
        selectedNodeIds: [],
        draggingNodeIds: [],
        editingNodeIds,
      },
    });

  beforeEach(() => {
    useCanvasPresenceStore.setState({
      pages: {},
      pointers: {},
      localEditingNodeId: null,
    });
  });

  it('is refused with a hint, from whichever surface asks, and allowed again once that page finishes', async () => {
    editedBy([X]);

    await expect(state().tryRename('node', X, 'Renamed here')).resolves.toBe(
      false,
    );
    expect(node(X).data.label).toBe(`Label ${X}`);
    expect(api.putNodeContent).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('Chrome · Mac'),
      { tone: 'info' },
    );

    // A node nobody else is editing is renamed as before.
    await expect(state().tryRename('node', Y, 'Renamed Y')).resolves.toBe(true);
    expect(node(Y).data.label).toBe('Renamed Y');

    editedBy([]);
    await expect(state().tryRename('node', X, 'Renamed here')).resolves.toBe(
      true,
    );
    expect(node(X).data.label).toBe('Renamed here');
  });

  it('leaves moving and recolouring the node alone', async () => {
    editedBy([X]);

    state().beginGesture('SET_NODE_GEOMETRY');
    state().setNodeGeometry([{ nodeId: X, position: { x: 250, y: 40 } }]);
    state().executeCommands([
      {
        type: 'MERGE_NODE_DATA',
        patches: [
          {
            nodeId: X as `node-${string}`,
            patch: { style: { accent: 'red' } },
          },
        ],
      },
    ]);

    expect(node(X).position).toEqual({ x: 250, y: 40 });
    expect(node(X).data.style).toEqual({ accent: 'red' });
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('a node frozen by a content conflict the user has not answered', () => {
  const noEffects = {
    mutatedNodeIds: [],
    deletedNodeIds: [],
    contentEditedNodeIds: [],
    deferredFitFrameIds: [],
  } as never;
  const conflictToast = () =>
    vi
      .mocked(toast)
      .mock.calls.filter(
        ([, options]) => options?.secondaryAction?.label === 'Keep mine',
      );
  /** An `update` from the stream that replaces `prev` with `next`. */
  function deliver(prev: Node, next: Node, source: 'ui' | 'agent') {
    const { version } = state();
    const deltas = [{ type: 'REPLACE_NODE', prev, next }] as never;
    // The server names the stored revision of a node whose content changed.
    const nodeContentRevisions = contentRevisionsOf(deltas);
    return state().applyServerDeltas(
      deltas,
      version + 1,
      noEffects,
      undefined,
      undefined,
      { source, ...(nodeContentRevisions ? { nodeContentRevisions } : {}) },
    );
  }
  /** Whether the page would still refuse to save Y on its own. */
  async function staysFrozen() {
    const before = api.putNodeContent.mock.calls.length;
    state().updateNodeData(Y, { content: `${node(Y).data.content}!` });
    await vi.advanceTimersByTimeAsync(10_000);
    return api.putNodeContent.mock.calls.length === before;
  }

  beforeEach(async () => {
    // Start from what the server holds, then type; another page saved first.
    api.getNodeContent.mockResolvedValue({
      ...savedOnServer(`Body ${Y}`, `Label ${Y}`),
      nodeId: Y,
    });
    await adoptRemoteNodeContent(SPACE, [Y]);
    state().updateNodeData(Y, { content: 'Mine' });
    api.putNodeContent.mockRejectedValueOnce(
      new CanvasConflictError({
        code: 'NODE_CONTENT_CONFLICT',
        message: 'changed elsewhere',
        nodeId: Y,
        currentRev: nodeRevisionOf({ content: 'Theirs' }),
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.putNodeContent).toHaveBeenCalledTimes(1);
    expect(conflictToast()).toHaveLength(1);
    vi.mocked(dismissToast).mockClear();
  });

  afterEach(async () => {
    // The content queue outlives a test: forget the frozen node the way a
    // deletion does.
    useCanvasStore.setState({ nodes: [], isLoading: false });
    await vi.advanceTimersByTimeAsync(10_000);
  });

  it('stays frozen, with its choice, through an update to another node', async () => {
    deliver(node(X), { ...node(X), position: { x: 400, y: 300 } }, 'ui');
    expect(node(X).position).toEqual({ x: 400, y: 300 });
    expect(dismissToast).not.toHaveBeenCalled();
    expect(await staysFrozen()).toBe(true);
    expect(node(Y).data.content).toBe('Mine!');
  });

  it('stays frozen through an update that moves it', async () => {
    // The server's copy of the node carries the body the server holds.
    const server = { ...node(Y), data: { ...node(Y).data, content: 'Theirs' } };
    deliver(server, { ...server, position: { x: 900, y: 300 } }, 'ui');
    expect(node(Y).position).toEqual({ x: 900, y: 300 });
    expect(dismissToast).not.toHaveBeenCalled();
    expect(await staysFrozen()).toBe(true);
    expect(node(Y).data.content).toBe('Mine!');
  });

  it("stays frozen when an update carries someone else's body for it, and Keep mine then replaces that body", async () => {
    const server = { ...node(Y), data: { ...node(Y).data, content: 'Theirs' } };
    const skipped = deliver(
      server,
      { ...server, data: { ...server.data, content: 'Agent' } },
      'agent',
    );
    // The page keeps what the user typed and says so.
    expect(skipped).toEqual([Y]);
    expect(node(Y).data.content).toBe('Mine');
    // The conflict is still the user's to answer: nothing is written.
    expect(dismissToast).not.toHaveBeenCalled();
    expect(await staysFrozen()).toBe(true);
    expect(node(Y).data.content).toBe('Mine!');

    // Keep mine overwrites what the server holds now, knowingly.
    conflictToast()[0][1]?.secondaryAction?.onClick();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.putNodeContent).toHaveBeenCalledTimes(2);
    expect(api.putNodeContent.mock.calls[1][2]).toMatchObject({
      content: 'Mine!',
      expectRev: nodeRevisionOf({ content: 'Agent' }),
    });
  });

  it('is no longer a conflict when an update brings exactly what the user typed', async () => {
    const server = { ...node(Y), data: { ...node(Y).data, content: 'Theirs' } };
    const skipped = deliver(
      server,
      {
        ...server,
        position: { x: 900, y: 300 },
        data: { ...server.data, content: 'Mine' },
      },
      'agent',
    );
    // Nothing of the user's was kept back from anybody: nothing is reported,
    // the rest of the update applies, the text is the one they typed.
    expect(skipped).toEqual([]);
    expect(node(Y).data.content).toBe('Mine');
    expect(node(Y).position).toEqual({ x: 900, y: 300 });
    // The conflict toast is gone and no other toast took its place.
    expect(dismissToast).toHaveBeenCalledWith('toast-id');
    expect(vi.mocked(toast).mock.calls).toHaveLength(1);
    // Typing goes on from the server's revision, without a choice.
    expect(await staysFrozen()).toBe(false);
    expect(api.putNodeContent.mock.calls.at(-1)?.[2]).toMatchObject({
      content: 'Mine!',
      expectRev: nodeRevisionOf({ content: 'Mine' }),
    });
  });

  it('stays frozen when an update brings the text with one character more', async () => {
    const server = { ...node(Y), data: { ...node(Y).data, content: 'Theirs' } };
    const skipped = deliver(
      server,
      { ...server, data: { ...server.data, content: 'Mine.' } },
      'agent',
    );
    expect(skipped).toEqual([Y]);
    expect(node(Y).data.content).toBe('Mine');
    expect(dismissToast).not.toHaveBeenCalled();
    expect(await staysFrozen()).toBe(true);
  });

  it("is no longer a conflict when another page's save left exactly what the user typed", async () => {
    api.getNodeContent.mockResolvedValue({
      ...savedOnServer('Mine', `Label ${Y}`),
      nodeId: Y,
    });
    await adoptRemoteNodeContent(SPACE, [Y]);
    expect(node(Y).data.content).toBe('Mine');
    expect(dismissToast).toHaveBeenCalledWith('toast-id');
    expect(vi.mocked(toast).mock.calls).toHaveLength(1);
    expect(await staysFrozen()).toBe(false);
    expect(api.putNodeContent.mock.calls.at(-1)?.[2]).toMatchObject({
      content: 'Mine!',
      expectRev: nodeRevisionOf({ content: 'Mine' }),
    });
  });

  it("stays frozen when another page's save differs by one character, and Keep mine then replaces that save", async () => {
    api.getNodeContent.mockResolvedValue({
      ...savedOnServer('mine', `Label ${Y}`),
      nodeId: Y,
    });
    await adoptRemoteNodeContent(SPACE, [Y]);
    expect(node(Y).data.content).toBe('Mine');
    expect(dismissToast).not.toHaveBeenCalled();
    expect(await staysFrozen()).toBe(true);
    conflictToast()[0][1]?.secondaryAction?.onClick();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.putNodeContent.mock.calls.at(-1)?.[2]).toMatchObject({
      content: 'Mine!',
      expectRev: nodeRevisionOf({ content: 'mine' }),
    });
  });

  it('lets Keep mine overwrite the revision the update names, not a hash of the node it carries', async () => {
    const server = { ...node(Y), data: { ...node(Y).data, content: 'Theirs' } };
    const next = { ...server, data: { ...server.data, content: 'Agent' } };
    api.getNodeContent.mockClear();
    const skipped = state().applyServerDeltas(
      [{ type: 'REPLACE_NODE', prev: server, next }] as never,
      state().version + 1,
      noEffects,
      undefined,
      undefined,
      { source: 'agent', nodeContentRevisions: { [Y]: 'stored-agent-rev' } },
    );
    expect(skipped).toEqual([Y]);
    expect(dismissToast).not.toHaveBeenCalled();
    expect(await staysFrozen()).toBe(true);
    // Nothing is fetched: the update said what the server stored.
    expect(api.getNodeContent).not.toHaveBeenCalled();

    conflictToast()[0][1]?.secondaryAction?.onClick();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.putNodeContent.mock.calls.at(-1)?.[2]).toMatchObject({
      content: 'Mine!',
      expectRev: 'stored-agent-rev',
    });
  });

  it('asks the server what it holds when an update for it names no revision', async () => {
    api.getNodeContent.mockClear();
    api.getNodeContent.mockResolvedValue({
      ...savedOnServer('Agent', `Label ${Y}`),
      nodeId: Y,
      rev: 'fetched-agent-rev',
    });
    const server = { ...node(Y), data: { ...node(Y).data, content: 'Theirs' } };
    const next = { ...server, data: { ...server.data, content: 'Agent' } };
    const skipped = state().applyServerDeltas(
      [{ type: 'REPLACE_NODE', prev: server, next }] as never,
      state().version + 1,
      noEffects,
      undefined,
      undefined,
      { source: 'agent' },
    );
    expect(skipped).toEqual([Y]);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.getNodeContent).toHaveBeenCalledExactlyOnceWith(SPACE, Y);
    // The fetched body is not the user's: still theirs to answer.
    expect(dismissToast).not.toHaveBeenCalled();
    expect(await staysFrozen()).toBe(true);

    conflictToast()[0][1]?.secondaryAction?.onClick();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.putNodeContent.mock.calls.at(-1)?.[2]).toMatchObject({
      content: 'Mine!',
      expectRev: 'fetched-agent-rev',
    });
  });

  it('stays frozen through a wanted reload and a gap', async () => {
    const { requestCanvasResync } = await import('./canvasStore');
    requestCanvasResync(SPACE);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.getCanvas).not.toHaveBeenCalled();
    expect(state().pendingContentNodeIds()).toContain(Y);
    expect(await staysFrozen()).toBe(true);
  });
});
