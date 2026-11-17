// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cloneArtifactToCanvas } from '@/api/artifact';
import {
  CanvasConflictError,
  postCanvasExecute,
  putNodeContent,
} from '@/api/canvas';
import { toast } from '@/components/Common/Toast';

import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore, {
  commitNodeMetadata,
  commitNodeProperties,
  flushNodeContent,
  resetCanvasSyncForTests,
  setCanvasSyncLineageForTests,
} from './canvasStore';
import {
  createFakeSpaceServer,
  FAKE_LINEAGE,
} from './canvasStore/sync/testing/fakeExecuteServer';
import { openPdfNotes } from './previewWorkspace/actions';
import { useWorkspaceStore } from './workspaceStore';

import type * as Api from '@/api';
import type * as ArtifactApi from '@/api/artifact';
import type * as CanvasApi from '@/api/canvas';
import type {
  CanvasCommand,
  CanvasNodeId,
  PutNodeContentRequest,
} from '@huabu/shared';
import type { Delta } from '@huabu/shared/canvas-engine';
import type { Node } from '@xyflow/react';

vi.mock('@/api/artifact', async (importActual) => ({
  ...(await importActual<typeof ArtifactApi>()),
  cloneArtifactToCanvas: vi.fn(),
}));

vi.mock('@/api/canvasEvents', () => ({
  postCanvasEvents: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('@/components/Common/Toast', () => ({
  toast: vi.fn(() => 'metadata-toast'),
  dismissToast: vi.fn(),
}));
// Only transport is substituted. Structure goes to the execute double (the
// real engine over a server copy of the Space); nothing saves the whole Space.
const api = vi.hoisted(() => ({
  putNodeContent: vi.fn(),
  deleteNode: vi.fn(),
  postCanvasExecute: vi.fn(),
}));
vi.mock('@/api/canvas', async (importActual) => ({
  ...(await importActual<typeof CanvasApi>()),
  ...api,
}));
vi.mock('@/api', async (importActual) => ({
  ...(await importActual<typeof Api>()),
  ...api,
}));

const server = createFakeSpaceServer();

describe('durable node metadata actions', () => {
  it('creates real owned notes once and restores the entire pair when undoing deletion', async () => {
    seed('node-paper');
    openPdfNotes('node-paper');
    const pdf = useCanvasStore
      .getState()
      .nodes.find((node) => node.id === 'node-paper');
    const noteId = pdf?.data.noteNodeId;
    if (typeof noteId !== 'string') throw new Error('Missing owned Note');
    expect(
      useCanvasStore.getState().nodes.find((node) => node.id === noteId),
    ).toMatchObject({ type: 'note', hidden: true });
    openPdfNotes('node-paper');
    expect(useCanvasStore.getState().nodes).toHaveLength(2);
    useCanvasStore
      .getState()
      .updateNodeData(noteId, { content: 'Authored notes' });
    await vi.waitFor(
      () =>
        expect(putNodeContent).toHaveBeenCalledWith(
          'node-paper',
          noteId,
          expect.objectContaining({
            nodeType: 'note',
            content: 'Authored notes',
          }),
          undefined,
        ),
      { timeout: 3000 },
    );
    useCanvasStore.getState().deleteNodes(['node-paper']);
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
    // The deletion is one command; the engine takes the owned Note with it.
    await vi.waitFor(() => expect(server.state.nodes).toHaveLength(0));
    await useCanvasStore.getState().undo();
    const pair = expect.arrayContaining([
      expect.objectContaining({
        id: 'node-paper',
        data: expect.objectContaining({ noteNodeId: noteId }),
      }),
      expect.objectContaining({
        id: noteId,
        hidden: true,
        data: expect.objectContaining({ content: 'Authored notes' }),
      }),
    ]);
    expect(useCanvasStore.getState().nodes).toEqual(pair);
    // The undo is saved as one RESTORE_NODES batch that carries both nodes,
    // the Note's body and the ownership link; no whole-Space save exists.
    await vi.waitFor(() => expect(server.state.nodes).toEqual(pair));
    expect(server.requests.at(-1)?.commands).toEqual([
      expect.objectContaining({
        type: 'RESTORE_NODES',
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: 'node-paper' }),
          expect.objectContaining({ id: noteId }),
        ]),
      }),
    ]);
    expect(useCanvasStore.getState().nodes).toEqual(pair);
  });

  it('sends the PDF note with the id this page shows, and undoes and redoes its creation as commands', async () => {
    seed('node-paper');
    openPdfNotes('node-paper');
    const noteId = useCanvasStore
      .getState()
      .nodes.find((node) => node.id === 'node-paper')?.data.noteNodeId;
    expect(server.requests.at(-1)?.commands).toEqual([
      { type: 'INITIALIZE_PDF_NOTE', nodeId: 'node-paper', noteId },
    ]);
    const linked = expect.arrayContaining([
      expect.objectContaining({
        id: 'node-paper',
        data: expect.objectContaining({ noteNodeId: noteId }),
      }),
      expect.objectContaining({ id: noteId, type: 'note', hidden: true }),
    ]);
    await vi.waitFor(() => expect(server.state.nodes).toEqual(linked));
    await vi.waitFor(() => expect(useCanvasStore.getState().version).toBe(2));
    expect(useCanvasStore.getState().nodes).toHaveLength(2);

    await useCanvasStore.getState().undo();
    await vi.waitFor(() => expect(server.state.nodes).toHaveLength(1));
    expect(server.state.nodes[0].data).not.toHaveProperty('noteNodeId');
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
    expect(useCanvasStore.getState().nodes[0].data).not.toHaveProperty(
      'noteNodeId',
    );

    await useCanvasStore.getState().redo();
    await vi.waitFor(() => expect(server.state.nodes).toEqual(linked));
    expect(useCanvasStore.getState().nodes).toEqual(linked);
    expect(
      server.requests.flatMap((request) =>
        (request.commands as CanvasCommand[]).flatMap((command, index) =>
          command.type === 'SET_NODE_SELECTION' ? [] : [[command.type, index]],
        ),
      ),
    ).toEqual([
      ['INITIALIZE_PDF_NOTE', 0],
      ['DELETE_NODES', 0],
      ['MERGE_NODE_DATA', 1],
      ['RESTORE_NODES', 0],
      ['MERGE_NODE_DATA', 1],
    ]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('drops its own optimistic PDF note when another page gave the PDF its note first', async () => {
    seed('node-paper');
    // Page B's request is committed before this page's.
    const other = server.execute('node-paper', {
      commands: [
        {
          type: 'INITIALIZE_PDF_NOTE',
          nodeId: 'node-paper' as CanvasNodeId,
          noteId: 'node-theirs' as CanvasNodeId,
        },
      ],
      originator: { source: 'ui', tabId: 'page-b' },
      operationId: crypto.randomUUID(),
    });
    openPdfNotes('node-paper');
    const mine = useCanvasStore
      .getState()
      .nodes.find((node) => node.id === 'node-paper')?.data.noteNodeId;
    expect(mine).not.toBe('node-theirs');
    // The stream then brings page B's update.
    const state = useCanvasStore.getState();
    state.applyDeltasFromAgent(
      other.deltas as Delta[],
      other.toVersion,
      other.pendingEffects as Parameters<typeof state.applyDeltasFromAgent>[2],
      false,
      { events: other.orderEvents },
      {
        operationId: other.operationId,
        source: 'ui',
        nodeContentRevisions: other.nodeContentRevisions,
      },
    );
    await vi.waitFor(() =>
      expect(
        useCanvasStore
          .getState()
          .nodes.map((node) => node.id)
          .sort(),
      ).toEqual(['node-paper', 'node-theirs']),
    );
    expect(
      useCanvasStore.getState().nodes.find((node) => node.id === 'node-paper')
        ?.data.noteNodeId,
    ).toBe('node-theirs');
    expect(server.state.nodes.map((node) => node.id).sort()).toEqual([
      'node-paper',
      'node-theirs',
    ]);
  });
  beforeEach(() => {
    useWorkspaceStore.setState({ workspaceId: 'metadata-tests' });
    vi.mocked(putNodeContent).mockReset();
    vi.mocked(putNodeContent).mockImplementation(
      async (_canvasId, nodeId, body) => ({
        nodeId,
        label: body.label ?? null,
        rev: 'saved',
      }),
    );
    api.deleteNode.mockReset();
    api.deleteNode.mockResolvedValue({ success: true });
    resetCanvasSyncForTests();
    vi.mocked(postCanvasExecute).mockReset();
    vi.mocked(postCanvasExecute).mockImplementation(async (canvasId, request) =>
      server.execute(canvasId, request),
    );
    vi.mocked(toast).mockClear();
  });

  function seed(id: string) {
    canvasHistoryManager.activate(id, true);
    const nodes: Node[] = [
      {
        id,
        type: 'pdf',
        position: { x: 0, y: 0 },
        data: {
          label: 'Paper',
          content: 'Extracted text',
          properties: { keep: 'yes' },
        },
      },
    ];
    server.reset(structuredClone(nodes), [], 1);
    setCanvasSyncLineageForTests(id, FAKE_LINEAGE);
    useCanvasStore.getState()._setStateNoAutosave({
      canvasId: id,
      isLoading: false,
      version: 1,
      nodes,
      edges: [],
    });
  }

  it('rejects failures without rolling back authored edits, and reports a property saved although the body is frozen by a conflict', async () => {
    seed('metadata-failure');
    vi.mocked(putNodeContent).mockRejectedValueOnce(
      new CanvasConflictError({
        code: 'NODE_CONTENT_CONFLICT',
        message: 'stale',
        currentRev: 'remote',
      }),
    );
    await expect(
      commitNodeMetadata('metadata-failure', {
        properties: { reviewed: true },
      }),
    ).rejects.toThrow();
    expect(useCanvasStore.getState().nodes[0].data.properties).toEqual({
      keep: 'yes',
      reviewed: true,
    });
    // The refusal froze the node's body (this node had no baseline, so the
    // request carried everything). Properties are not part of that: the
    // next change goes out by itself and is saved.
    await expect(
      commitNodeMetadata('metadata-failure', {
        properties: { reviewed: false },
      }),
    ).resolves.toBeUndefined();
    expect(useCanvasStore.getState().nodes[0].data.properties).toEqual({
      keep: 'yes',
      reviewed: false,
    });
    const sent = vi.mocked(putNodeContent).mock.calls.at(-1)?.[2];
    expect(sent?.properties).toEqual({ reviewed: false });
    expect(sent).not.toHaveProperty('expectRev');
    expect(sent).not.toHaveProperty('content');
    // The body is still the user's to answer.
    expect(useCanvasStore.getState().pendingContentNodeIds()).toContain(
      'metadata-failure',
    );

    // A property that cannot be sent at all is not reported as saved.
    useCanvasStore
      .getState()
      .patchNodeSilent('metadata-failure', { contentMissing: true });
    await expect(
      commitNodeMetadata('metadata-failure', {
        properties: { reviewed: true },
      }),
    ).rejects.toThrow('not saved');
  });

  it.each([{ field: 'propertyDisplayKeys', value: ['keep'], cleared: [] }])(
    'persists undo of the first $field edit before reload',
    async ({ field, value, cleared }) => {
      const id = `undo-${field}`;
      seed(id);
      const serverData: Record<string, unknown> = {};
      vi.mocked(putNodeContent).mockImplementation(
        async (_canvas, nodeId, body) => {
          Object.assign(serverData, body);
          return { nodeId, label: 'Paper', rev: 'saved' };
        },
      );
      const patch = { [field]: value } as Pick<
        PutNodeContentRequest,
        'propertyDisplayKeys'
      >;
      await commitNodeProperties(id, patch);
      expect(serverData[field]).toEqual(value);
      await useCanvasStore.getState().undo();
      await vi.waitFor(() => expect(serverData[field]).toEqual(cleared), {
        timeout: 3000,
      });
      seed(id);
      useCanvasStore
        .getState()
        .patchNodeSilent(id, { [field]: serverData[field] });
      expect(useCanvasStore.getState().nodes[0].data[field]).toEqual(cleared);
    },
  );

  it('clones PDF note images on cross-Space paste without rewriting extracted text', async () => {
    seed('paste-destination');
    vi.mocked(cloneArtifactToCanvas).mockResolvedValue('artifact-cloned.png');
    const noteContent = '![note](artifact-note.png)';
    const dispatch = vi.spyOn(useCanvasStore.getState(), 'dispatchUiIntent');
    useCanvasStore.getState().pasteNodes(
      { x: 0, y: 0 },
      [
        {
          id: 'source-pdf',
          type: 'pdf',
          position: { x: 0, y: 0 },
          data: { noteNodeId: 'source-notes', content: noteContent },
        },
        {
          id: 'source-notes',
          type: 'note',
          position: { x: 0, y: 0 },
          data: { content: noteContent },
        },
      ],
      [],
      'paste-source',
    );
    await vi.waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PASTE_CLIPBOARD',
          clipboardNodes: [
            expect.objectContaining({
              data: {
                noteNodeId: 'source-notes',
                content: noteContent,
              },
            }),
            expect.objectContaining({
              data: { content: '![note](artifact-cloned.png)' },
            }),
          ],
        }),
      ),
    );
    expect(cloneArtifactToCanvas).toHaveBeenCalledExactlyOnceWith(
      'paste-source',
      'artifact-note.png',
      'paste-destination',
    );
    const pasted = useCanvasStore.getState().nodes;
    const pdf = pasted.find(
      (node) => node.type === 'pdf' && node.id !== 'paste-destination',
    );
    expect(pdf?.data.noteNodeId).not.toBe('source-notes');
    expect(
      pasted.find((node) => node.id === pdf?.data.noteNodeId),
    ).toMatchObject({
      type: 'note',
      hidden: true,
      data: { content: '![note](artifact-cloned.png)' },
    });
    // The pasted pair is one batch through the send queue: the server
    // creates the same two nodes, linked, with the cloned image.
    await vi.waitFor(() =>
      expect(server.state.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: pdf?.id,
            data: expect.objectContaining({
              noteNodeId: pdf?.data.noteNodeId,
            }),
          }),
          expect.objectContaining({
            id: pdf?.data.noteNodeId,
            type: 'note',
            hidden: true,
            data: expect.objectContaining({
              content: '![note](artifact-cloned.png)',
            }),
          }),
        ]),
      ),
    );
    dispatch.mockRestore();
  });

  it('retracts properties and only resubmits when the toast Retry action runs', async () => {
    seed('properties-retry');
    vi.mocked(putNodeContent).mockRejectedValueOnce(new Error('offline'));
    expect(
      await commitNodeProperties('properties-retry', {
        properties: { reviewed: true },
        propertyDisplayKeys: ['keep', 'reviewed'],
      }),
    ).toBe(false);
    expect(useCanvasStore.getState().nodes[0].data.properties).toEqual({
      keep: 'yes',
    });
    expect(putNodeContent).toHaveBeenCalledTimes(1);
    expect(canvasHistoryManager.canUndo).toBe(false);
    const retry = vi.mocked(toast).mock.calls.at(-1)?.[1]?.action?.onClick;
    expect(retry).toBeTypeOf('function');
    retry?.();
    await vi.waitFor(() => expect(putNodeContent).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(useCanvasStore.getState().nodes[0].data.properties).toEqual({
        keep: 'yes',
        reviewed: true,
      }),
    );
    expect(canvasHistoryManager.canUndo).toBe(true);
    expect(useCanvasStore.getState().pendingContentNodeIds()).not.toContain(
      'properties-retry',
    );
    const state = useCanvasStore.getState();
    expect(
      canvasHistoryManager.undo(state.nodes, state.edges)?.nodes[0].data
        .properties,
    ).toEqual({ keep: 'yes' });
  });

  it.each(['property', 'workspace'] as const)(
    'rejects a stale toast retry after a %s change',
    async (change) => {
      seed(`properties-stale-${change}`);
      vi.mocked(putNodeContent).mockRejectedValueOnce(new Error('offline'));
      await commitNodeProperties(`properties-stale-${change}`, {
        properties: { keep: 'new' },
      });
      const retry = vi.mocked(toast).mock.calls.at(-1)?.[1]?.action?.onClick;
      expect(retry).toBeTypeOf('function');
      if (change === 'workspace')
        useWorkspaceStore.setState({ workspaceId: 'other' });
      else {
        const state = useCanvasStore.getState();
        state._setStateNoAutosave({
          nodes: state.nodes.map((node) => ({
            ...node,
            data: { ...node.data, properties: { keep: 'later' } },
          })),
        });
      }
      retry?.();
      await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
      expect(putNodeContent).toHaveBeenCalledTimes(1);
      expect(vi.mocked(toast).mock.calls.at(-1)?.[1]?.action).toBeUndefined();
    },
  );

  it('is not saved a second time when the editor that committed it loses focus mid-save', async () => {
    seed('properties-release');
    let answer!: (value: {
      nodeId: string;
      label: string | null;
      rev: string;
    }) => void;
    vi.mocked(putNodeContent).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const committed = commitNodeProperties('properties-release', {
      properties: { reviewed: true },
    });
    await vi.waitFor(() => expect(putNodeContent).toHaveBeenCalledTimes(1));
    // The field is disabled while saving, so focus leaves it: the page
    // releases its edit lock once the node's content is on the server.
    let released = false;
    const release = flushNodeContent('properties-release').then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    answer({ nodeId: 'properties-release', label: 'Paper', rev: 'saved' });
    await expect(committed).resolves.toBe(true);
    await release;
    expect(released).toBe(true);
    expect(putNodeContent).toHaveBeenCalledTimes(1);
    expect(useCanvasStore.getState().pendingContentNodeIds()).not.toContain(
      'properties-release',
    );
  });

  it('retracts a conflicting property edit without offering an ordinary retry', async () => {
    seed('properties-conflict');
    vi.mocked(putNodeContent).mockRejectedValueOnce(
      new CanvasConflictError({
        code: 'NODE_CONTENT_CONFLICT',
        message: 'stale',
        currentRev: 'remote',
      }),
    );
    expect(
      await commitNodeProperties('properties-conflict', {
        properties: { keep: 'new' },
      }),
    ).toBe(false);
    expect(useCanvasStore.getState().nodes[0].data.properties).toEqual({
      keep: 'yes',
    });
    expect(vi.mocked(toast).mock.calls.at(-1)?.[1]?.action).toBeUndefined();
    expect(putNodeContent).toHaveBeenCalledTimes(1);
  });

  it('does not report a save in a different backend Workspace as successful', async () => {
    seed('metadata-scope');
    vi.mocked(putNodeContent).mockImplementationOnce(
      async (_canvasId, nodeId) => {
        useWorkspaceStore.setState({ workspaceId: 'another-backend' });
        return { nodeId, label: 'Paper', rev: 'saved' };
      },
    );
    await expect(
      commitNodeMetadata('metadata-scope', { properties: { Draft: true } }),
    ).rejects.toThrow();
  });
});
