// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

const api = vi.hoisted(() => ({
  putCanvas: vi.fn(),
  deleteNode: vi.fn(),
  putNodeContent: vi.fn(),
  getCanvas: vi.fn(),
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
vi.mock('@/components/Common/Toast', () => ({ toast: vi.fn() }));

import { toast } from '@/components/Common/Toast';

import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore, {
  drainPendingSaves,
  settleNodePreprocess,
} from './canvasStore';
import { CanvasConflictError } from '../api/canvas';

import type * as apiModule from '../api';
import type * as canvasApiModule from '../api/canvas';
import type { PutCanvasRequest, PutNodeContentRequest } from '@huabu/shared';
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
let tombstone: boolean;
let structureGate: ReturnType<typeof deferred> | undefined;
let deleteGate: ReturnType<typeof deferred> | undefined;
let contentGate: ReturnType<typeof deferred> | undefined;
let calls: string[];
const state = () => useCanvasStore.getState();

// Only transport is substituted: the store, history, dirty detector, queues,
// debounce, and OCC reconciliation are real. This transport explicitly models
// the server's split topology/sidecar contract, including benign tombstone 200
// and revision refusal. The acceptance spec checks the real Disk endpoints.
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  structureGate = deleteGate = contentGate = undefined;
  version = 1;
  topology = [note];
  body = note.data.content as string;
  tombstone = false;
  calls = [];
  canvasHistoryManager.activate('restore-canvas', true);
  state()._setStateNoAutosave({
    canvasId: 'restore-canvas',
    canvasTitle: 'Restore',
    nodes: [note],
    edges: [],
    version: 1,
    isLoading: false,
    isSaving: false,
    pendingSave: false,
    versionConflict: false,
    versionConflictServerVersion: null,
  });
  api.putCanvas.mockImplementation(
    async (_id: string, request: PutCanvasRequest) => {
      calls.push('structure:start');
      const gate = structureGate;
      structureGate = undefined;
      await gate?.promise;
      if (request.version !== version)
        throw new CanvasConflictError({
          code: 'CANVAS_VERSION_CONFLICT',
          message: 'version',
          serverVersion: version,
        });
      const next = (request.state as { nodes: Node[] }).nodes;
      if (
        !topology.some((n) => n.id === note.id) &&
        next.some((n) => n.id === note.id)
      )
        tombstone = false;
      topology = next;
      version++;
      calls.push('structure:committed');
      return { canvasId: 'restore-canvas', version };
    },
  );
  api.deleteNode.mockImplementation(async () => {
    calls.push('delete:start');
    const gate = deleteGate;
    deleteGate = undefined;
    await gate?.promise;
    body = undefined;
    tombstone = true;
    calls.push('delete:committed');
    return { success: true };
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
        label: 'Restore note',
        rev: nodeRevisionOf({ content: body }),
      };
    },
  );
  api.preprocessNode.mockResolvedValue({ success: true });
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
                label: 'Restore note',
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

function remove() {
  state().executeCommands([
    { type: 'DELETE_NODES', nodeIds: [note.id as `node-${string}`] },
  ]);
}
async function deleted() {
  remove();
  await state().saveCanvas();
  calls = [];
  api.putCanvas.mockClear();
  api.putNodeContent.mockClear();
}
async function tick() {
  await vi.advanceTimersByTimeAsync(0);
}

describe('undo/redo persistence ordering', () => {
  it('retains a new edit-settle during restored content PUT even without interrupted work', async () => {
    await deleted();
    const gate = (contentGate = deferred());
    state().undo();
    const draining = drainPendingSaves();
    await tick();
    expect(calls).toContain('content:start');
    useCanvasStore.setState({
      nodes: [
        {
          ...state().nodes[0],
          data: {
            ...state().nodes[0].data,
            content: '# Edited during restore',
          },
        },
      ],
    });
    settleNodePreprocess(note.id);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.preprocessNode).not.toHaveBeenCalled();
    gate.resolve();
    await draining;
    await drainPendingSaves();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.preprocessNode).toHaveBeenCalledOnce();
    expect(api.preprocessNode.mock.calls[0][2].snapshot.content).toBe(
      '# Edited during restore',
    );
    expect(body).toBe('# Edited during restore');
    expect(state().ingestionByNodeId[note.id]).toBeUndefined();
  });

  it.each([false, true])(
    'preserves preprocessing across an unrelated history change (issued=%s)',
    async (issued) => {
      const other: Node = {
        ...note,
        id: 'node-other',
        position: { x: 100, y: 0 },
      };
      state()._setStateNoAutosave({
        nodes: [note, other],
        ingestionByNodeId: {},
      });
      canvasHistoryManager.takeSnapshot([note, other], []);
      state()._setStateNoAutosave({
        nodes: [note, { ...other, position: { x: 200, y: 0 } }],
      });
      const gate = deferred();
      api.preprocessNode.mockImplementationOnce(async () => {
        await gate.promise;
        return { success: true, summary: 'Useful result' };
      });
      settleNodePreprocess(note.id);
      if (issued) await vi.advanceTimersByTimeAsync(2_000);
      state().undo();
      expect(state().ingestionByNodeId[note.id]?.status).toBe('pending');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(api.preprocessNode).toHaveBeenCalledOnce();
      gate.resolve();
      await tick();
      expect(state().nodes[0].data.summary).toBe('Useful result');
      expect(state().ingestionByNodeId[note.id]).toBeUndefined();
      await drainPendingSaves();
    },
  );

  it.each([false, true])(
    'resumes unfinished preprocessing after resurrected content commits (issued=%s)',
    async (issued) => {
      const old = deferred();
      if (issued)
        api.preprocessNode.mockImplementationOnce(async () => {
          await old.promise;
          return { success: true, summary: 'Obsolete result' };
        });
      settleNodePreprocess(note.id);
      if (issued) await vi.advanceTimersByTimeAsync(2_000);
      remove();
      expect(state().ingestionByNodeId[note.id]).toBeUndefined();
      state().undo();
      const write = (contentGate = deferred());
      const draining = drainPendingSaves();
      old.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(api.preprocessNode).toHaveBeenCalledTimes(issued ? 1 : 0);
      expect(state().nodes[0].data.summary).toBeUndefined();
      expect(state().pendingContentNodeIds()).toContain(note.id);
      write.resolve();
      await draining;
      api.preprocessNode.mockResolvedValueOnce({
        success: true,
        summary: 'Resumed result',
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(api.preprocessNode).toHaveBeenCalledTimes(issued ? 2 : 1);
      expect(state().nodes[0].data.summary).toBe('Resumed result');
      expect(state().ingestionByNodeId[note.id]).toBeUndefined();
      await drainPendingSaves();
    },
  );

  it('does not resume preprocessing until a failed restored content save succeeds on Retry', async () => {
    settleNodePreprocess(note.id);
    await deleted();
    api.putNodeContent.mockRejectedValueOnce(new Error('Disk unavailable'));
    state().undo();
    await expect(drainPendingSaves()).rejects.toThrow('Restored node content');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.preprocessNode).not.toHaveBeenCalled();
    const retry = vi
      .mocked(toast)
      .mock.calls.find(
        ([, options]) => options?.action?.label === 'Retry',
      )?.[1]?.action;
    expect(retry).toBeDefined();
    retry?.onClick();
    await tick();
    await drainPendingSaves();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.preprocessNode).toHaveBeenCalledOnce();
  });

  it('retains unfinished work through rapid undo/redo without starting it for an absent node', async () => {
    settleNodePreprocess(note.id);
    await deleted();
    const gate = (structureGate = deferred());
    state().undo();
    const saving = state().saveCanvas();
    await tick();
    state().redo();
    gate.resolve();
    await saving;
    await drainPendingSaves();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.preprocessNode).not.toHaveBeenCalled();
    state().undo();
    await drainPendingSaves();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.preprocessNode).toHaveBeenCalledOnce();
  });

  it('holds content until structure commits, then survives authoritative reload', async () => {
    await deleted();
    const gate = (structureGate = deferred());
    state().undo();
    const saving = state().saveCanvas();
    await vi.advanceTimersByTimeAsync(500);
    expect(api.putNodeContent).not.toHaveBeenCalled();
    expect(state().pendingContentNodeIds()).toContain(note.id);
    gate.resolve();
    await saving;
    await drainPendingSaves();
    expect(calls.indexOf('structure:committed')).toBeLessThan(
      calls.indexOf('content:start'),
    );
    expect(calls).not.toContain('content:suppressed');
    expect(api.putNodeContent.mock.calls[0][2].expectRev).toBe(
      nodeRevisionOf({}),
    );
    await state().loadCanvas('restore-canvas');
    expect(state().nodes[0].data.content).toBe(note.data.content);
    expect(state().nodes[0].data.contentMissing).toBe(false);
  });

  it('waits for a pending DELETE response rather than aborting it', async () => {
    const gate = (deleteGate = deferred());
    remove();
    await tick();
    state().undo();
    const saving = state().saveCanvas();
    await tick();
    expect(api.putCanvas).not.toHaveBeenCalled();
    expect(api.putNodeContent).not.toHaveBeenCalled();
    gate.resolve();
    await saving;
    await drainPendingSaves();
    expect(calls.indexOf('delete:committed')).toBeLessThan(
      calls.indexOf('structure:start'),
    );
    expect(body).toBe(note.data.content);
  });

  it('rapid redo while waiting for deletion never sends the obsolete resurrection', async () => {
    const gate = (deleteGate = deferred());
    remove();
    await tick();
    state().undo();
    const saving = state().saveCanvas();
    await tick();
    state().redo();
    gate.resolve();
    await saving;
    await drainPendingSaves();
    expect(topology).toEqual([]);
    expect(body).toBeUndefined();
    expect(api.putNodeContent).not.toHaveBeenCalled();
    expect(state().pendingContentNodeIds()).toEqual([]);
    await expect(state().switchCanvas('other')).resolves.toBeUndefined();
    expect(state().canvasId).toBe('other');
  });

  it('rapid redo clears an absent restore before its in-flight structure acknowledgement', async () => {
    await deleted();
    const gate = (structureGate = deferred());
    state().undo();
    const saving = state().saveCanvas();
    await tick();
    expect(api.putCanvas).toHaveBeenCalledOnce();
    expect(state().pendingContentNodeIds()).toContain(note.id);
    state().redo();
    expect(state().nodes).toEqual([]);
    expect(state().pendingContentNodeIds()).toEqual([]);
    gate.resolve();
    await saving;
    await expect(drainPendingSaves()).resolves.toBeUndefined();
    expect(api.putNodeContent).not.toHaveBeenCalled();
    expect(topology).toEqual([]);
    expect(body).toBeUndefined();
    await expect(state().switchCanvas('other')).resolves.toBeUndefined();
    expect(state().canvasId).toBe('other');
  });

  it.each(['undo', 'redo'] as const)(
    'rejects delayed preprocessing after live-node %s has fully persisted',
    async (direction) => {
      const original: Node = {
        ...note,
        type: 'office',
        data: {
          content: 'Original extracted body',
          src: 'artifact-original.docx',
          label: 'Restore note',
          labelSource: 'auto',
        },
      };
      const edited: Node = {
        ...original,
        data: {
          ...original.data,
          content: 'Edited extracted body',
          src: 'artifact-edited.docx',
        },
      };
      state()._setStateNoAutosave({ nodes: [original] });
      canvasHistoryManager.takeSnapshot([original], []);
      state()._setStateNoAutosave({ nodes: [edited] });
      // Derived Office bodies use last-write-wins, not authored-body CAS.
      api.putNodeContent.mockImplementation(
        async (_canvas, _id, request: PutNodeContentRequest) => {
          body = request.content;
          return {
            nodeId: original.id,
            label: request.label ?? null,
            rev: nodeRevisionOf({ content: body, src: request.src }),
          };
        },
      );
      if (direction === 'redo') {
        state().undo();
        await drainPendingSaves();
      }
      const restored = direction === 'undo' ? original : edited;
      const gate = deferred();
      const staleResponse = {
        success: true,
        content: 'Stale extracted body',
        src: 'artifact-stale.docx',
        suggestedLabel: 'Stale label',
        summary: 'Stale summary',
        keywords: ['stale'],
      };
      api.preprocessNode.mockImplementationOnce(async () => {
        await gate.promise;
        return staleResponse;
      });
      settleNodePreprocess(original.id);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(api.preprocessNode).toHaveBeenCalledOnce();

      state()[direction]();
      await drainPendingSaves();
      expect(body).toBe(restored.data.content);
      expect(state().pendingContentNodeIds()).toEqual([]);
      gate.resolve();
      await tick();
      expect(state().nodes[0].data).toEqual(restored.data);
      await drainPendingSaves();
      expect(body).toBe(restored.data.content);

      // A request started after restoration still projects all ordinary fields.
      const freshResponse = {
        ...staleResponse,
        content: 'Fresh extracted body',
        src: 'artifact-fresh.docx',
      };
      api.preprocessNode.mockResolvedValueOnce(freshResponse);
      settleNodePreprocess(original.id);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(api.preprocessNode).toHaveBeenCalledTimes(2);
      expect(state().nodes[0].data).toMatchObject({
        content: freshResponse.content,
        src: freshResponse.src,
        label: freshResponse.suggestedLabel,
        labelSource: 'auto',
        summary: freshResponse.summary,
        keywords: freshResponse.keywords,
      });
      await drainPendingSaves();
      expect(body).toBe(freshResponse.content);
    },
  );

  it('an obsolete structure acknowledgement cannot release a later undo generation', async () => {
    await deleted();
    const gate = (structureGate = deferred());
    state().undo();
    const saving = state().saveCanvas();
    await tick();
    state().redo();
    state().undo();
    gate.resolve();
    await saving;
    await tick();
    expect(api.putNodeContent).not.toHaveBeenCalled();
    await drainPendingSaves();
    expect(body).toBe(note.data.content);
  });

  it('waits for already-issued preprocessing before DELETE and then restores without deadlock', async () => {
    const gate = deferred();
    api.preprocessNode.mockImplementationOnce(async () => {
      await gate.promise;
      return {
        success: true,
        content: 'Obsolete body',
        src: 'artifact-obsolete',
        suggestedLabel: 'Obsolete label',
      };
    });
    settleNodePreprocess(note.id);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.preprocessNode).toHaveBeenCalledOnce();
    remove();
    state().undo();
    const draining = drainPendingSaves();
    await tick();
    expect(state().pendingContentNodeIds()).toContain(note.id);
    expect(api.deleteNode).not.toHaveBeenCalled();
    expect(api.putCanvas).not.toHaveBeenCalled();
    expect(api.putNodeContent).not.toHaveBeenCalled();
    gate.resolve();
    await draining;
    expect(calls.indexOf('delete:committed')).toBeLessThan(
      calls.indexOf('structure:start'),
    );
    expect(calls.indexOf('structure:committed')).toBeLessThan(
      calls.indexOf('content:start'),
    );
    expect(body).toBe(note.data.content);
    expect(state().nodes[0].data).toEqual(note.data);
    expect(state().pendingContentNodeIds()).toEqual([]);
    await expect(state().switchCanvas('other')).resolves.toBeUndefined();
  });

  it('keeps the snapshot on structure failure and retries via the existing Retry action', async () => {
    await deleted();
    const gate = (structureGate = deferred());
    state().undo();
    const saving = state().saveCanvas();
    gate.reject(new Error('disk unavailable'));
    await saving;
    await tick();
    expect(api.putNodeContent).not.toHaveBeenCalled();
    expect(state().nodes[0].data.content).toBe(note.data.content);
    expect(state().pendingContentNodeIds()).toContain(note.id);
    const options = vi.mocked(toast).mock.calls.at(-1)?.[1];
    expect(options?.action).toBeDefined();
    options?.action?.onClick();
    await tick();
    await drainPendingSaves();
    expect(body).toBe(note.data.content);
  });

  it('an unresolved version conflict keeps content blocked and prevents Canvas switch', async () => {
    await deleted();
    version++;
    state().undo();
    await state().saveCanvas();
    await tick();
    expect(state().versionConflict).toBe(true);
    expect(api.putNodeContent).not.toHaveBeenCalled();
    await expect(state().loadCanvas('other')).rejects.toThrow(
      'Restored node content',
    );
    await expect(state().switchCanvas('other')).rejects.toThrow(
      'Restored node content',
    );
    expect(state().versionConflict).toBe(true);
    expect(state().canvasId).toBe('restore-canvas');
    // Existing SSE reconciliation clears the version gate and retries.
    state().applyDeltasFromAgent([], version, {
      mutatedNodes: [],
      deletedNodeIds: [],
      contentEditedNodeIds: [],
      deferredFitFrameIds: [],
    });
    await drainPendingSaves();
    expect(body).toBe(note.data.content);
  });

  it('Canvas switch waits for restoration; stale acknowledgements do not patch a different Canvas', async () => {
    await deleted();
    const gate = (structureGate = deferred());
    state().undo();
    const switching = state().switchCanvas('other');
    await tick();
    expect(state().canvasId).toBe('restore-canvas');
    gate.resolve();
    await switching;
    expect(body).toBe(note.data.content);
    expect(state().canvasId).toBe('other');
    expect(state().nodes).toEqual([]);
  });

  it('drains in-flight restored content before a subsequent DELETE', async () => {
    await deleted();
    const gate = (contentGate = deferred());
    state().undo();
    await state().saveCanvas();
    await tick();
    expect(calls).toContain('content:start');
    state().redo();
    await tick();
    expect(calls).not.toContain('delete:start');
    gate.resolve();
    await drainPendingSaves();
    expect(calls.indexOf('content:committed')).toBeLessThan(
      calls.indexOf('delete:start'),
    );
    expect(body).toBeUndefined();
    expect(topology).toEqual([]);
  });

  it('retains a restored body after content failure until content Retry succeeds', async () => {
    await deleted();
    const gate = (contentGate = deferred());
    state().undo();
    await state().saveCanvas();
    await tick();
    gate.reject(new Error('content write failed'));
    await tick();
    expect(state().pendingContentNodeIds()).toContain(note.id);
    await expect(drainPendingSaves()).rejects.toThrow('Restored node content');
    expect(state().nodes[0].data.content).toBe(note.data.content);
    vi.mocked(toast).mock.calls.at(-1)?.[1]?.action?.onClick();
    await tick();
    await drainPendingSaves();
    expect(body).toBe(note.data.content);
  });

  it('does not apply an old structure acknowledgement to an externally replaced Canvas', async () => {
    await deleted();
    const gate = (structureGate = deferred());
    state().undo();
    const saving = state().saveCanvas();
    await tick();
    state()._setStateNoAutosave({
      canvasId: 'other',
      nodes: [],
      version: 50,
      isSaving: false,
    });
    gate.resolve();
    await saving;
    await tick();
    expect(state().version).toBe(50);
    expect(state().nodes).toEqual([]);
    expect(api.putNodeContent).not.toHaveBeenCalled();
    // Return solely to release the test's retained queue state in afterEach.
    state()._setStateNoAutosave({ canvasId: 'restore-canvas', nodes: [note] });
  });

  it.each([undefined, true])(
    'does not invent an empty body from an incomplete snapshot (%s)',
    async (missing) => {
      const incomplete = {
        ...note,
        data: {
          label: 'Restore note',
          ...(missing ? { contentMissing: true, content: '' } : {}),
        },
      };
      state()._setStateNoAutosave({ nodes: [incomplete] });
      await deleted();
      state().undo();
      await drainPendingSaves();
      expect(api.putNodeContent).not.toHaveBeenCalled();
      expect(body).toBeUndefined();
      expect(state().nodes[0].data.contentMissing).toBe(true);
    },
  );

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
    expect(api.putCanvas).not.toHaveBeenCalled();
    expect(api.putNodeContent.mock.calls[0][2].expectRev).toBe(
      nodeRevisionOf({ content: note.data.content as string }),
    );
  });
});
