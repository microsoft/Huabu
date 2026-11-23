// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

const api = vi.hoisted(() => ({
  postCanvasExecute: vi.fn(),
  putNodeContent: vi.fn(),
  getCanvas: vi.fn(),
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
vi.mock('@/components/Common/Toast', () => ({ toast: vi.fn() }));

import { toast } from '@/components/Common/Toast';

import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore, {
  discardPendingSaves,
  drainPendingSaves,
  resetCanvasSyncForTests,
  saveCanvasForSubmission,
  endNodeEditing,
} from './canvasStore';
import { ApiError } from '../api/_client';
import { CanvasConflictError } from '../api/canvas';
import { createFakeExecuteServer } from './canvasStore/sync/testing/fakeExecuteServer';
import {
  openPreviewNode,
  openSpaceConversation,
} from './previewWorkspace/actions';
import { createEmptyWorkspace } from './previewWorkspace/model';
import { usePreviewWorkspaceStore } from './previewWorkspace/store';

import type * as apiModule from '../api';
import type * as canvasApiModule from '../api/canvas';
import type {
  PostCanvasExecuteRequest,
  PutNodeContentRequest,
} from '@huabu/shared';
import type { Node } from '@xyflow/react';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const note: Node = {
  id: 'node-restore-note',
  type: 'note',
  position: { x: 0, y: 0 },
  style: { width: 300, height: 200 },
  data: {
    type: 'note',
    content: 'The complete original body',
    label: 'Restore note',
    heightMode: 'fixed',
  },
};
let version: number;
let topology: Node[];
let body: string | undefined;
let serverLabel: string;
let tombstone: boolean;
let executeGate: ReturnType<typeof deferred> | undefined;
let contentGate: ReturnType<typeof deferred> | undefined;
let calls: string[];
const state = () => useCanvasStore.getState();

// Only transport is substituted: the store, history, queues and debounce are
// real. This transport explicitly models the server's split topology/sidecar
// contract, including benign tombstone 200 and revision refusal.
//
// Every structure change — the deletion these cases start from, and the undo
// that brings the node back — is an execute request, answered by the real
// engine over `topology` / `version`. As on the server, a batch that deletes
// the node unlinks its sidecar and one that restores it writes the sidecar
// from the command. Nothing saves the whole Space.
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetCanvasSyncForTests();
  const executeServer = createFakeExecuteServer(
    () => ({ nodes: topology, edges: [], version }),
    (next) => {
      topology = next.nodes;
      version = next.version;
    },
  );
  api.postCanvasExecute.mockImplementation(async (canvasId, request) => {
    calls.push('execute:start');
    const gate = executeGate;
    executeGate = undefined;
    await gate?.promise;
    const response = executeServer.execute(canvasId, request);
    const sent = (request as PostCanvasExecuteRequest).edits.flatMap(
      (edit, position) =>
        (edit.commands as Array<Record<string, unknown>>).map(
          (command, index) => ({
            command,
            applied:
              response.edits[position]?.applied === true &&
              response.edits[position]?.results[index]?.applied === true,
          }),
        ),
    );
    sent.forEach(({ command, applied }) => {
      if (!applied) return;
      if (
        command.type === 'DELETE_NODES' &&
        (command.nodeIds as string[]).includes(note.id)
      ) {
        body = undefined;
        tombstone = true;
        calls.push('delete:executed');
      }
      const restored =
        command.type === 'RESTORE_NODES'
          ? (command.nodes as Node[]).find((n) => n.id === note.id)
          : undefined;
      if (restored) {
        body = restored.data.content as string;
        tombstone = false;
        calls.push('restore:committed');
      }
    });
    return response;
  });
  executeGate = contentGate = undefined;
  version = 1;
  topology = [note];
  body = note.data.content as string;
  serverLabel = 'Restore note';
  tombstone = false;
  calls = [];
  canvasHistoryManager.activate('restore-canvas', true);
  state()._setStateRaw({
    canvasId: 'restore-canvas',
    canvasTitle: 'Restore',
    nodes: [note],
    edges: [],
    version: 1,
    isLoading: false,
  });
  api.putNodeContent.mockImplementation(
    async (_canvas: string, _id: string, request: PutNodeContentRequest) => {
      calls.push('content:start');
      const gate = contentGate;
      contentGate = undefined;
      await gate?.promise;
      const currentRev = nodeRevisionOf(
        body === undefined ? {} : { content: body },
      );
      if (request.expectRev !== currentRev)
        throw new CanvasConflictError({
          code: 'NODE_CONTENT_CONFLICT',
          message: 'revision',
          currentRev,
        });
      if (tombstone && !topology.some((n) => n.id === note.id)) {
        calls.push('content:suppressed');
        return { nodeId: note.id, label: null, rev: nodeRevisionOf({}) };
      }
      body = request.content ?? body;
      calls.push('content:committed');
      return {
        nodeId: note.id,
        label: serverLabel,
        rev: nodeRevisionOf({ content: body }),
      };
    },
  );
  api.postCanvasEvents.mockResolvedValue({ success: true });
  api.getCanvas.mockImplementation(async (canvasId: string) => ({
    canvasId,
    title: 'Loaded',
    version,
    state: {
      nodes:
        canvasId === 'restore-canvas'
          ? topology.map((n) => ({
              ...n,
              data: {
                ...n.data,
                label: serverLabel,
                content: body ?? '',
                contentMissing: body === undefined,
              },
            }))
          : [],
      edges: [],
    },
  }));
});

afterEach(async () => {
  // Release queue bookkeeping using the same deletion diff as production,
  // without issuing another server delete or advancing unrelated timers.
  useCanvasStore.setState({ nodes: [], isLoading: false });
  await Promise.resolve();
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function tick() {
  await vi.advanceTimersByTimeAsync(0);
}

function remove() {
  state().executeCommands([
    { type: 'DELETE_NODES', nodeIds: [note.id as `node-${string}`] },
  ]);
}
/** The note is deleted, on this page and on the server. */
async function deleted() {
  remove();
  await vi.waitFor(() => expect(calls).toContain('delete:executed'));
  await tick();
  calls = [];
  api.postCanvasExecute.mockClear();
  api.putNodeContent.mockClear();
}
/** Content saves that said the editor was left, by what else they carried. */
const editingEndedSaves = () =>
  api.putNodeContent.mock.calls
    .map(([, , request]) => request as PutNodeContentRequest)
    .filter((request) => request.editingEnded === true);

describe('undo/redo persistence ordering', () => {
  it('says the edited Note’s editor was left when a Space conversation is opened, on a content save', async () => {
    topology = [{ ...note, data: { ...note.data, labelSource: 'auto' } }];
    await state().loadCanvas('restore-canvas');
    usePreviewWorkspaceStore.setState({
      canvasId: 'restore-canvas',
      workspace: createEmptyWorkspace(),
    });
    const tabId = openPreviewNode(note.id, { transient: false });
    state().updateNodeData(note.id, { content: '# Updated heading' });
    await vi.advanceTimersByTimeAsync(2_000);
    // Typing saves the body and says nothing more.
    expect(body).toBe('# Updated heading');
    expect(editingEndedSaves()).toEqual([]);

    openSpaceConversation('child-canvas', 'agent', 'thread');
    await vi.advanceTimersByTimeAsync(2_000);
    // Leaving the editor has nothing left to save; the save says only that.
    expect(editingEndedSaves()).toHaveLength(1);
    expect(editingEndedSaves()[0]).not.toHaveProperty('content');
    expect(body).toBe('# Updated heading');
    expect(
      usePreviewWorkspaceStore.getState().workspace.tabs[tabId],
    ).toBeDefined();
  });

  it('says it once, and an unrelated undo neither repeats nor loses it', async () => {
    await state().loadCanvas('restore-canvas');
    const other: Node = {
      ...note,
      id: 'node-other',
      position: { x: 100, y: 0 },
    };
    state()._setStateRaw({ nodes: [note, other] });
    canvasHistoryManager.takeSnapshot([note, other], []);
    state()._setStateRaw({
      nodes: [note, { ...other, position: { x: 200, y: 0 } }],
    });
    const gate = (contentGate = deferred());
    endNodeEditing(note.id);
    state().undo();
    await vi.advanceTimersByTimeAsync(2_000);
    gate.resolve();
    await drainPendingSaves();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(editingEndedSaves()).toHaveLength(1);
  });

  it('carries the body typed last together with the mark, in one save', async () => {
    await state().loadCanvas('restore-canvas');
    state().updateNodeData(note.id, { content: '# Typed, then left at once' });
    endNodeEditing(note.id);
    await drainPendingSaves();
    expect(editingEndedSaves()).toEqual([
      expect.objectContaining({ content: '# Typed, then left at once' }),
    ]);
    expect(body).toBe('# Typed, then left at once');
  });

  it('sends nothing for an absent node through rapid undo/redo', async () => {
    await state().loadCanvas('restore-canvas');
    endNodeEditing(note.id);
    await drainPendingSaves();
    expect(editingEndedSaves()).toHaveLength(1);
    await deleted();
    const gate = (executeGate = deferred());
    state().undo();
    await tick();
    state().redo();
    gate.resolve();
    await drainPendingSaves();
    await vi.advanceTimersByTimeAsync(2_000);
    // Deleted again before the restore landed: no save of any kind.
    expect(api.putNodeContent).not.toHaveBeenCalled();
  });

  it('rapid redo while waiting for deletion ends with the note deleted and no content write', async () => {
    const gate = (executeGate = deferred());
    remove();
    await tick();
    state().undo();
    await tick();
    // The restore is queued behind the deletion; nothing has been sent for it.
    expect(calls.filter((call) => call === 'execute:start')).toHaveLength(1);
    state().redo();
    gate.resolve();
    await drainPendingSaves();
    // The restore and the deletion that follows it are sent in order.
    expect(calls.indexOf('restore:committed')).toBeLessThan(
      calls.lastIndexOf('delete:executed'),
    );
    expect(topology).toEqual([]);
    expect(body).toBeUndefined();
    expect(api.putNodeContent).not.toHaveBeenCalled();
    expect(state().pendingContentNodeIds()).toEqual([]);
    await expect(state().switchCanvas('other')).resolves.toBeUndefined();
    expect(state().canvasId).toBe('other');
  });

  it('restores a deleted PDF, whose body never reaches the web, without calling it missing', async () => {
    const pdf = {
      ...note,
      type: 'pdf',
      data: { label: 'Paper', src: 'artifacts/paper.pdf' },
    };
    topology = [pdf];
    state()._setStateRaw({ nodes: [pdf] });
    await deleted();
    state().undo();
    await drainPendingSaves();
    // The node goes back in the restoring batch, with the file it shows and
    // no body: the web never held one. Nothing writes the record a second
    // time.
    const restores = api.postCanvasExecute.mock.calls.flatMap(([, request]) =>
      (
        (request as PostCanvasExecuteRequest).edits.flatMap(
          (edit) => edit.commands,
        ) as Array<{ type: string; nodes?: Node[] }>
      ).filter((command) => command.type === 'RESTORE_NODES'),
    );
    expect(restores).toHaveLength(1);
    expect(restores[0].nodes).toHaveLength(1);
    expect(restores[0].nodes?.[0]).toMatchObject({
      id: pdf.id,
      type: 'pdf',
      data: { src: pdf.data.src },
    });
    expect(restores[0].nodes?.[0].data).not.toHaveProperty('content');
    expect(calls).toContain('restore:committed');
    expect(api.putNodeContent).not.toHaveBeenCalled();
    expect(topology.map((n) => n.id)).toEqual([pdf.id]);
    expect(state().nodes[0].data.contentMissing).toBeUndefined();
  });

  it('sends a restored Note once, in the restoring batch', async () => {
    await deleted();
    state().undo();
    await drainPendingSaves();
    await vi.advanceTimersByTimeAsync(1000);
    // The body came back in the restoring batch, once.
    expect(calls.filter((call) => call === 'restore:committed')).toHaveLength(
      1,
    );
    expect(body).toBe(note.data.content);
    expect(api.putNodeContent).not.toHaveBeenCalled();
  });

  it('ordinary typing still saves on its own cadence without a structure PUT', async () => {
    // Seed the authoritative baseline through the real load boundary.
    await state().loadCanvas('restore-canvas');
    useCanvasStore.setState({
      nodes: [
        {
          ...state().nodes[0],
          data: { ...state().nodes[0].data, content: 'edited' },
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(body).toBe('edited');
    expect(api.putNodeContent.mock.calls[0][2].expectRev).toBe(
      nodeRevisionOf({ content: note.data.content as string }),
    );
  });

  it('persists grouped root exits through undo and redo as parent commands', async () => {
    const frame: Node = {
      id: 'node-source-frame',
      type: 'frame',
      position: { x: 500, y: 600 },
      style: { width: 1200, height: 800 },
      data: { label: 'Source', sizing: 'manual', layoutMode: 'free' },
    };
    const child = { ...note, parentId: frame.id, selected: true };
    const other = { ...child, id: 'node-other', position: { x: 400, y: 0 } };
    state()._setStateRaw({ nodes: [frame, child, other] });
    topology = [frame, child, other];
    const parents = () =>
      topology
        .filter((node) => node.id === child.id || node.id === other.id)
        .map((node) => node.parentId ?? null);
    state().moveNodeOutOfFrame([other.id, child.id]);
    await tick();
    expect(parents()).toEqual([null, null]);
    expect(state().canUndo).toBe(true);
    state().undo();
    await tick();
    expect(parents()).toEqual([frame.id, frame.id]);
    expect(state().canRedo).toBe(true);
    state().redo();
    await tick();
    expect(parents()).toEqual([null, null]);
  });

  it('brings a deleted note back with its body in one command, without a content PUT', async () => {
    await deleted();
    expect(topology).toEqual([]);
    expect(body).toBeUndefined();

    state().undo();
    expect(state().nodes.map((node) => node.id)).toEqual([note.id]);
    await drainPendingSaves();
    expect(topology.map((node) => node.id)).toEqual([note.id]);
    expect(body).toBe('The complete original body');
    expect(calls).toEqual(['execute:start', 'restore:committed']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.putNodeContent).not.toHaveBeenCalled();
    expect(state().pendingContentNodeIds()).toEqual([]);
  });

  it('sends the restore only after the batch that deleted the node is answered, and nothing else unlinks it', async () => {
    const gate = (executeGate = deferred());
    remove();
    await tick();
    expect(calls).toEqual(['execute:start']);
    state().undo();
    await vi.advanceTimersByTimeAsync(2_000);
    // The deletion has not been answered: the restore is not sent yet.
    expect(calls).not.toContain('restore:committed');
    expect(calls.filter((call) => call === 'execute:start')).toHaveLength(1);

    gate.resolve();
    await drainPendingSaves();
    expect(calls.indexOf('delete:executed')).toBeLessThan(
      calls.indexOf('restore:committed'),
    );
    // The server deleted the record in the batch; the page sent no request
    // of its own that could land after the restore.
    expect(calls.filter((call) => call.startsWith('delete:'))).toEqual([
      'delete:executed',
    ]);
    expect(body).toBe('The complete original body');
    expect(topology.map((node) => node.id)).toEqual([note.id]);
  });

  it('saves an edit made to the returning note only after the restore has landed', async () => {
    await deleted();
    const gate = (executeGate = deferred());
    state().undo();
    await tick();
    state().updateNodeData(note.id, { content: '# Edited during restore' });
    await vi.advanceTimersByTimeAsync(2_000);
    // Saved now, the edit would be a write to a node the server deleted.
    expect(api.putNodeContent).not.toHaveBeenCalled();

    gate.resolve();
    await drainPendingSaves();
    expect(calls.indexOf('restore:committed')).toBeLessThan(
      calls.indexOf('content:start'),
    );
    expect(calls).toContain('content:committed');
    expect(body).toBe('# Edited during restore');
  });

  it('says the editor of the returning note was left only once the restore is answered', async () => {
    await deleted();
    const gate = (executeGate = deferred());
    state().undo();
    await tick();
    state().updateNodeData(note.id, { content: '# Edited during restore' });
    endNodeEditing(note.id);
    await vi.advanceTimersByTimeAsync(2_000);
    // The server does not hold the node yet: nothing is said about it.
    expect(api.putNodeContent).not.toHaveBeenCalled();

    gate.resolve();
    await drainPendingSaves();
    expect(calls.indexOf('restore:committed')).toBeLessThan(
      calls.indexOf('content:start'),
    );
    expect(editingEndedSaves()).toEqual([
      expect.objectContaining({ content: '# Edited during restore' }),
    ]);
  });

  it('holds leaving the Space until the restore is answered', async () => {
    await deleted();
    const gate = (executeGate = deferred());
    state().undo();
    let left = false;
    const leaving = saveCanvasForSubmission('restore-canvas').then(() => {
      left = true;
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(left).toBe(false);
    gate.resolve();
    await leaving;
    expect(topology.map((node) => node.id)).toEqual([note.id]);
  });

  it('adopts the server Space when the restore is refused', async () => {
    await deleted();
    // Another page has put a node with the same id back meanwhile.
    topology = [{ ...note, position: { x: 900, y: 900 } }];
    version += 1;
    body = 'Restored elsewhere';
    tombstone = false;

    state().undo();
    await drainPendingSaves().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.getCanvas).toHaveBeenCalled();
    expect(state().nodes[0]).toMatchObject({
      position: { x: 900, y: 900 },
      data: { content: 'Restored elsewhere' },
    });
    expect(body).toBe('Restored elsewhere');
  });

  it('Retry on the failed save of an edited returning note sends the restore again', async () => {
    await deleted();
    const gate = (executeGate = deferred());
    state().undo();
    await tick();
    state().updateNodeData(note.id, { content: '# Edited during restore' });
    await vi.advanceTimersByTimeAsync(2_000);
    // The server refuses the restoring request outright.
    gate.reject(new ApiError(400, { message: 'Bad request' }, 'Bad request'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(topology).toEqual([]);
    // The edit is still on the page, and its save is reported as failed.
    expect(state().nodes[0]?.data.content).toBe('# Edited during restore');
    const failed = vi
      .mocked(toast)
      .mock.calls.filter(([, options]) => options?.action?.label === 'Retry')
      .at(-1);
    expect(failed).toBeDefined();
    expect(api.putNodeContent).not.toHaveBeenCalled();
    calls = [];

    failed?.[1]?.action?.onClick();
    await vi.advanceTimersByTimeAsync(2_000);
    // Retry brought the node back on the server, with the edited body.
    expect(calls.slice(0, 2)).toEqual(['execute:start', 'restore:committed']);
    expect(topology.map((node) => node.id)).toEqual([note.id]);
    expect(body).toBe('# Edited during restore');
    expect(state().pendingContentNodeIds()).toEqual([]);
    await expect(drainPendingSaves()).resolves.toBeUndefined();
  });

  it('leaving the Space sends a failed restore again before the edit that waits for it', async () => {
    await deleted();
    const gate = (executeGate = deferred());
    state().undo();
    await tick();
    state().updateNodeData(note.id, { content: '# Edited during restore' });
    await vi.advanceTimersByTimeAsync(2_000);
    gate.reject(new ApiError(400, { message: 'Bad request' }, 'Bad request'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(topology).toEqual([]);

    await expect(drainPendingSaves()).resolves.toBeUndefined();
    expect(topology.map((node) => node.id)).toEqual([note.id]);
    expect(body).toBe('# Edited during restore');
  });

  it('redoes the deletion of a restored note and unlinks it once', async () => {
    await deleted();
    state().undo();
    await drainPendingSaves();
    calls = [];
    state().redo();
    await drainPendingSaves();
    expect(topology).toEqual([]);
    expect(body).toBeUndefined();
    expect(calls.filter((call) => call === 'delete:executed')).toHaveLength(1);
    expect(api.putNodeContent).not.toHaveBeenCalled();
  });

  it('blocks switching after ordinary content failure and preserves edits for Retry', async () => {
    await state().loadCanvas('restore-canvas');
    api.putNodeContent.mockRejectedValueOnce(new Error('disk unavailable'));
    useCanvasStore.setState({
      nodes: [
        {
          ...state().nodes[0],
          data: { ...state().nodes[0].data, content: 'Unsaved' },
        },
      ],
    });
    await expect(state().switchCanvas('other')).rejects.toThrow(
      'Content saves failed',
    );
    expect(state().canvasId).toBe('restore-canvas');
    expect(state().isLoading).toBe(false);
    expect(state().nodes[0].data.content).toBe('Unsaved');
    expect(state().pendingContentNodeIds()).toContain(note.id);
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    vi.mocked(toast).mock.calls.at(-1)?.[1]?.action?.onClick();
    await tick();
    await state().switchCanvas('other');
    expect(body).toBe('Unsaved');
    expect(state().canvasId).toBe('other');
  });

  it('explicit discard clears failed and pending edits without another write or fetch', async () => {
    await state().loadCanvas('restore-canvas');
    api.putNodeContent.mockRejectedValueOnce(new Error('disk unavailable'));
    useCanvasStore.setState({
      nodes: [
        {
          ...state().nodes[0],
          data: { ...state().nodes[0].data, content: 'Unsaved' },
        },
      ],
    });
    await expect(drainPendingSaves()).rejects.toThrow('Content saves failed');
    useCanvasStore.setState({
      nodes: [
        {
          ...state().nodes[0],
          position: { x: 100, y: 100 },
          data: { ...state().nodes[0].data, content: 'Later edit' },
        },
      ],
    });
    const retry = vi.mocked(toast).mock.calls.at(-1)?.[1]?.action?.onClick;
    await discardPendingSaves('restore-canvas');
    retry?.();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.putNodeContent).toHaveBeenCalledTimes(1);
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    expect(state().canvasId).toBe('');
    expect(state().nodes).toEqual([]);
    expect(state().pendingContentNodeIds()).toEqual([]);
    await expect(
      saveCanvasForSubmission('restore-canvas'),
    ).resolves.toBeUndefined();
    await state().loadCanvas('restore-canvas');
    expect(state().nodes[0].data.content).toBe(note.data.content);
    expect(state().canUndo).toBe(false);
  });

  it('retries a retained content failure when switching again', async () => {
    await state().loadCanvas('restore-canvas');
    api.putNodeContent.mockRejectedValueOnce(new Error('offline'));
    useCanvasStore.setState({
      nodes: [
        {
          ...state().nodes[0],
          data: { ...state().nodes[0].data, content: 'Recovered edit' },
        },
      ],
    });
    await expect(state().switchCanvas('other')).rejects.toThrow();
    expect(state().canvasId).toBe('restore-canvas');
    expect(state().isLoading).toBe(false);
    await state().switchCanvas('other');
    expect(state().canvasId).toBe('other');
    expect(api.putNodeContent).toHaveBeenCalledTimes(2);
    expect(body).toBe('Recovered edit');
  });

  it('waits for an issued save before discarding and cannot patch a later Space', async () => {
    await state().loadCanvas('restore-canvas');
    useCanvasStore.setState({
      nodes: [
        {
          ...state().nodes[0],
          data: { ...state().nodes[0].data, content: 'Issued edit' },
        },
      ],
    });
    const gate = (contentGate = deferred());
    const draining = drainPendingSaves();
    await tick();
    const discarding = discardPendingSaves('restore-canvas');
    await tick();
    expect(state().canvasId).toBe('restore-canvas');
    gate.resolve();
    await Promise.all([draining, discarding]);
    await state().switchCanvas('other');
    expect(body).toBe('Issued edit');
    expect(state().nodes).toEqual([]);
    expect(state().pendingContentNodeIds()).toEqual([]);
  });
});
