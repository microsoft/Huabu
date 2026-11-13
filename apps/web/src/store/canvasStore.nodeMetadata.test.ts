// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cloneArtifactToCanvas } from '@/api/artifact';
import { CanvasConflictError, putCanvas, putNodeContent } from '@/api/canvas';
import { toast } from '@/components/Common/Toast';

import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore, {
  commitNodeMetadata,
  commitNodeProperties,
} from './canvasStore';
import { openPdfNotes } from './previewWorkspace/actions';
import { useWorkspaceStore } from './workspaceStore';

import type * as ArtifactApi from '@/api/artifact';
import type * as CanvasApi from '@/api/canvas';
import type { PutNodeContentRequest } from '@huabu/shared';

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
vi.mock('@/api/canvas', async (importActual) => ({
  ...(await importActual<typeof CanvasApi>()),
  putNodeContent: vi.fn(),
  deleteNode: vi.fn().mockResolvedValue({ success: true }),
  putCanvas: vi.fn(async (canvasId: string) => ({ canvasId, version: 1 })),
}));

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
    await useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'node-paper',
          data: expect.objectContaining({ noteNodeId: noteId }),
        }),
        expect.objectContaining({
          id: noteId,
          hidden: true,
          data: expect.objectContaining({ content: 'Authored notes' }),
        }),
      ]),
    );
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
    vi.mocked(putCanvas).mockClear();
    vi.mocked(toast).mockClear();
  });

  function seed(id: string) {
    canvasHistoryManager.activate(id, true);
    useCanvasStore.getState()._setStateNoAutosave({
      canvasId: id,
      isLoading: false,
      isSaving: false,
      pendingSave: false,
      versionConflict: false,
      version: 1,
      nodes: [
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
      ],
      edges: [],
    });
  }

  it('rejects failures without rolling back authored edits and does not report frozen retries as saved', async () => {
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
    await expect(
      commitNodeMetadata('metadata-failure', {
        properties: { reviewed: false },
      }),
    ).rejects.toThrow('not saved');
    expect(useCanvasStore.getState().nodes[0].data.properties).toEqual({
      keep: 'yes',
      reviewed: false,
    });
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
