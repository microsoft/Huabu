// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Preprocessing as the server starts it: through the real executor and the
 * real pipeline on a Disk Space, with no page involved.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  preprocessAfterWrites,
  waitForNodePreprocessing,
} from './node-jobs.js';
import { executeOnServer } from '../canvas/canvas-executor.js';
import { subscribeCanvasUpdates } from '../canvas/canvas-sync.js';
import { setCommitReactions } from '../canvas/commit-follow-up.js';
import { getCanvasStore, space } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import { getPreprocessDispatcher } from './index.js';

import type { CanvasCommand, CanvasSyncEvent } from '@huabu/shared';

let tmp: string;
let events: CanvasSyncEvent[];
let unsubscribe: () => void;
const originalDataDir = process.env.HUABU_DATA_DIR;
const CANVAS = 'canvas-jobs';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-jobs-'));
  process.env.HUABU_DATA_DIR = tmp;
  setWorkspacePath(tmp);
  getCanvasStore(CANVAS).write({
    canvasId: CANVAS,
    title: null,
    version: 1,
    state: { nodes: [], edges: [] },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  events = [];
  unsubscribe = subscribeCanvasUpdates(CANVAS, (event) => events.push(event));
  setCommitReactions(preprocessAfterWrites);
});

afterEach(async () => {
  await waitForNodePreprocessing();
  setCommitReactions(undefined);
  unsubscribe();
  vi.restoreAllMocks();
  if (originalDataDir === undefined) delete process.env.HUABU_DATA_DIR;
  else process.env.HUABU_DATA_DIR = originalDataDir;
  rmSync(tmp, { recursive: true, force: true });
});

function run(commands: unknown[], source: 'ui' | 'agent' = 'agent') {
  return executeOnServer({
    canvasId: CANVAS,
    originator: { source },
    commands: commands as CanvasCommand[],
  });
}

const createNote = (id: string, data: Record<string, unknown>) => ({
  type: 'CREATE_NODES',
  nodes: [{ id, nodeType: 'note', position: { x: 0, y: 0 }, data }],
});
const sidecar = (id: string) => getCanvasStore(CANVAS).readNode(id);
const kinds = () =>
  events.map((event) =>
    event.type === 'update'
      ? 'update'
      : event.type === 'preprocess'
        ? `preprocess:${event.data.nodeId}:${event.data.status}`
        : event.type === 'invalidate'
          ? `invalidate:${(event.data.nodeIds ?? []).join(',')}`
          : event.type,
  );

describe('preprocessing started by the server after a write', () => {
  it('processes a created node with no page asking, and tells pages in order', async () => {
    const out = await run([
      createNote('node-a', { content: '# Derived title\n\nBody' }),
    ]);
    expect(out.results[0].applied).toBe(true);
    await waitForNodePreprocessing();

    // The write, then pending, the result, and the end.
    expect(kinds()).toEqual([
      'update',
      'preprocess:node-a:pending',
      'invalidate:node-a',
      'preprocess:node-a:done',
    ]);
    expect(sidecar('node-a')).toMatchObject({
      label: 'Derived title',
      labelSource: 'auto',
      content: '# Derived title\n\nBody',
    });
  });

  it('starts nothing for a write that changes no preprocessing input', async () => {
    await run([createNote('node-a', { label: 'Mine', labelSource: 'user' })]);
    await waitForNodePreprocessing();
    events.length = 0;
    const preprocess = vi.spyOn(getPreprocessDispatcher(), 'preprocess');

    const out = await run([
      {
        type: 'MERGE_NODE_DATA',
        patches: [
          {
            nodeId: 'node-a',
            patch: { frameColumn: 2, paintKey: 'a3', style: { accent: 'red' } },
          },
        ],
      },
      {
        type: 'SET_NODE_GEOMETRY',
        items: [{ nodeId: 'node-a', position: { x: 50, y: 50 } }],
      },
    ]);
    await waitForNodePreprocessing();

    expect(out.results.every((result) => result.applied)).toBe(true);
    expect(kinds()).toEqual(['update']);
    expect(preprocess).not.toHaveBeenCalled();
  });

  it('gives the pipeline the input the node had before, so only what changed is redone', async () => {
    await run([createNote('node-a', { label: 'First', labelSource: 'user' })]);
    await waitForNodePreprocessing();
    const preprocess = vi.spyOn(getPreprocessDispatcher(), 'preprocess');

    await run([
      {
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: 'node-a', patch: { label: 'Second' } }],
      },
    ]);
    await waitForNodePreprocessing();

    expect(preprocess).toHaveBeenCalledTimes(1);
    expect(preprocess.mock.calls[0][0]).toMatchObject({
      nodeId: 'node-a',
      snapshot: { title: 'Second' },
      previousSnapshot: { title: 'First' },
    });
  });

  it('keeps a title a person gave while the run was under way', async () => {
    const dispatcher = getPreprocessDispatcher();
    const real = dispatcher.preprocess.bind(dispatcher);
    vi.spyOn(dispatcher, 'preprocess').mockImplementation(async (request) => {
      const result = await real(request);
      // A person renames the node before the result is stored.
      getCanvasStore(CANVAS).writeNode('node-a', {
        ...sidecar('node-a')!,
        label: 'Theirs',
        labelSource: 'user',
      });
      return { ...result, patch: { ...result.patch, label: 'Suggested' } };
    });

    await run([createNote('node-a', { content: '# Derived\n\nBody' })]);
    await waitForNodePreprocessing();

    expect(sidecar('node-a')).toMatchObject({
      label: 'Theirs',
      labelSource: 'user',
    });
  });

  it('runs once more, after the current run, for a node written again meanwhile', async () => {
    const dispatcher = getPreprocessDispatcher();
    const real = dispatcher.preprocess.bind(dispatcher);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const spy = vi
      .spyOn(dispatcher, 'preprocess')
      .mockImplementationOnce(async (request) => {
        await held;
        return real(request);
      });

    await run([createNote('node-a', { label: 'One', labelSource: 'user' })]);
    const rename = (label: string) =>
      run([
        {
          type: 'MERGE_NODE_DATA',
          patches: [{ nodeId: 'node-a', patch: { label } }],
        },
      ]);
    await rename('Two');
    await rename('Three');
    release();
    await waitForNodePreprocessing();

    // The two writes made during the first run are one further run: the
    // latest input, against what the first run saw.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][0]).toMatchObject({
      snapshot: { title: 'Three' },
      previousSnapshot: { title: 'One' },
    });
    // Each run announces its own start and end.
    expect(kinds().filter((kind) => kind.startsWith('preprocess'))).toEqual([
      'preprocess:node-a:pending',
      'preprocess:node-a:done',
      'preprocess:node-a:pending',
      'preprocess:node-a:done',
    ]);
  });

  it('reports a failed run to pages', async () => {
    vi.spyOn(getPreprocessDispatcher(), 'preprocess').mockRejectedValue(
      new Error('pipeline down'),
    );
    await run([createNote('node-a', { content: 'Body' })]);
    await waitForNodePreprocessing();

    expect(events.at(-1)).toEqual({
      type: 'preprocess',
      data: { nodeId: 'node-a', status: 'error', error: 'pipeline down' },
    });
  });

  it('does nothing when the server was assembled without it', async () => {
    setCommitReactions(undefined);
    const preprocess = vi.spyOn(getPreprocessDispatcher(), 'preprocess');
    await run([createNote('node-a', { content: 'Body' })]);
    expect(kinds()).toEqual(['update']);
    expect(preprocess).not.toHaveBeenCalled();
  });

  it('leaves a note an undo brought back as it was restored', async () => {
    await run([
      createNote('node-a', { label: 'Kept title', content: '# Other\n\nBody' }),
    ]);
    await waitForNodePreprocessing();
    getCanvasStore(CANVAS).writeNode('node-a', {
      ...sidecar('node-a')!,
      label: 'Kept title',
    });
    await run([{ type: 'DELETE_NODES', nodeIds: ['node-a'] }], 'ui');
    await waitForNodePreprocessing();
    const preprocess = vi.spyOn(getPreprocessDispatcher(), 'preprocess');

    await run(
      [
        {
          type: 'RESTORE_NODES',
          nodes: [
            {
              id: 'node-a',
              type: 'note',
              position: { x: 0, y: 0 },
              data: { label: 'Kept title', content: '# Other\n\nBody' },
            },
          ],
        },
      ],
      'ui',
    );
    await waitForNodePreprocessing();

    // Nothing is derived for it: its title is not replaced by one read
    // from its body.
    expect(preprocess).not.toHaveBeenCalled();
    expect(sidecar('node-a')).toMatchObject({ label: 'Kept title' });
  });

  it('reacts to a title a page saved: the node itself, and the Frame holding it', async () => {
    await run([
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            id: 'node-frame',
            nodeType: 'frame',
            position: { x: 0, y: 0 },
            data: { label: 'Group', labelSource: 'user' },
          },
        ],
      },
    ]);
    await run([
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            id: 'node-a',
            nodeType: 'note',
            parentId: 'node-frame',
            position: { x: 0, y: 0 },
            data: { label: 'One', labelSource: 'user', content: 'Body' },
          },
        ],
      },
    ]);
    await waitForNodePreprocessing();
    const preprocess = vi.spyOn(getPreprocessDispatcher(), 'preprocess');
    const before = sidecar('node-a')!;
    const storedNodes = getCanvasStore(CANVAS).read()!.state.nodes as never[];
    const save = (after: typeof before) =>
      preprocessAfterWrites.contentSave({
        canvasId: CANVAS,
        nodeId: 'node-a',
        nodeType: 'note',
        before,
        after,
        storedNodes,
      });

    // A body typed on is the editor's to settle; an automatic title is what
    // preprocessing produced. Neither is a new input.
    expect(save({ ...before, content: 'Body, typed on' })).toBeUndefined();
    expect(
      save({ ...before, label: 'Derived', labelSource: 'auto' }),
    ).toBeUndefined();

    save({ ...before, label: 'Two' })?.();
    // The Frame's run starts after its children's titles are read.
    await vi.waitFor(() => expect(preprocess).toHaveBeenCalledTimes(2), {
      timeout: 15_000,
    });
    await waitForNodePreprocessing();
    const requests = preprocess.mock.calls.map(([request]) => request);
    expect(requests.find((r) => r.nodeId === 'node-a')).toMatchObject({
      nodeType: 'note',
      snapshot: { title: 'Two' },
      previousSnapshot: { title: 'One' },
    });
    expect(requests.find((r) => r.nodeId === 'node-frame')).toMatchObject({
      nodeType: 'frame',
      snapshot: { title: 'Group', childLabels: ['Two'] },
      previousSnapshot: { title: 'Group', childLabels: ['One'] },
    });
  });

  it('derives a note’s title when the save says the editor was left, and not before', async () => {
    await run([createNote('node-a', { content: '# First\n\nBody' })]);
    await waitForNodePreprocessing();
    expect(sidecar('node-a')).toMatchObject({ label: 'First' });
    // The body was typed on and saved while the editor stayed open.
    const before = sidecar('node-a')!;
    const typed = { ...before, content: '# Second heading\n\nBody' };
    getCanvasStore(CANVAS).writeNode('node-a', typed);
    const storedNodes = getCanvasStore(CANVAS).read()!.state.nodes as never[];
    const save = (editingEnded: boolean) =>
      preprocessAfterWrites.contentSave({
        canvasId: CANVAS,
        nodeId: 'node-a',
        nodeType: 'note',
        before,
        after: typed,
        storedNodes,
        ...(editingEnded ? { editingEnded } : {}),
      });
    expect(save(false)).toBeUndefined();

    // Leaving the editor saves nothing new, and says so.
    preprocessAfterWrites.contentSave({
      canvasId: CANVAS,
      nodeId: 'node-a',
      nodeType: 'note',
      before: typed,
      after: typed,
      storedNodes,
      editingEnded: true,
    })?.();
    await waitForNodePreprocessing();
    expect(sidecar('node-a')).toMatchObject({
      label: 'Second heading',
      labelSource: 'auto',
      content: '# Second heading\n\nBody',
    });
    // The flag means nothing for a node whose body no person edits.
    expect(
      preprocessAfterWrites.contentSave({
        canvasId: CANVAS,
        nodeId: 'node-a',
        nodeType: 'pdf',
        before: typed,
        after: typed,
        storedNodes,
        editingEnded: true,
      }),
    ).toBeUndefined();
  });

  it('runs once for the same input asked for twice, and names a returning Agent Node', async () => {
    const dispatcher = getPreprocessDispatcher();
    const real = dispatcher.preprocess.bind(dispatcher);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const spy = vi
      .spyOn(dispatcher, 'preprocess')
      .mockImplementationOnce(async (request) => {
        await held;
        return real(request);
      });
    await run([createNote('node-a', { content: '# Same\n\nBody' })]);
    const record = sidecar('node-a')!;
    const again = () =>
      preprocessAfterWrites.contentSave({
        canvasId: CANVAS,
        nodeId: 'node-a',
        nodeType: 'note',
        before: record,
        after: record,
        storedNodes: [],
        editingEnded: true,
      })?.();
    again();
    again();
    release();
    await waitForNodePreprocessing();
    expect(spy).toHaveBeenCalledTimes(1);

    // The returning node has its record, as the association route found it.
    await space(CANVAS).nodes.put({
      nodeId: 'node-q',
      record: {
        nodeId: 'node-q',
        type: 'question',
        label: '',
        content: 'What is this?',
      },
    });
    spy.mockClear();
    preprocessAfterWrites.agentNodeRestored(CANVAS, {
      id: 'node-q',
      type: 'question',
      position: { x: 0, y: 0 },
      data: { content: 'What is this?', threadId: 'thread-q' },
    } as never)?.();
    await waitForNodePreprocessing();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({
      nodeId: 'node-q',
      nodeType: 'question',
      snapshot: { content: 'What is this?' },
    });
  });
});
