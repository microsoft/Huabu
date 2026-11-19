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
vi.mock('@/api/canvasSync', async (actual) => ({
  ...(await actual<typeof canvasSyncApiModule>()),
  getCanvasContentChanges: vi.fn(async () => ({
    position: { epoch: 'e', seq: 0 },
  })),
}));
vi.mock('@/components/Common/Toast', () => ({
  toast: vi.fn(() => 'toast-id'),
  dismissToast: vi.fn(),
}));
vi.mock('@/utils/io/clipboard', () => ({
  copyToClipboard: vi.fn(async () => undefined),
}));

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import { toast } from '@/components/Common/Toast';
import { copyToClipboard } from '@/utils/io/clipboard';

import { useAcpThreadChangesStore } from './acpThreadChangesStore';
import { canvasHistoryManager } from './canvasHistoryManager';
import { CanvasConflictError } from '../api/canvas';
import { useCanvasPresenceStore } from './canvasPresence/canvasPresenceStore';
import useCanvasStore, {
  adoptRemoteNodeContent,
  resetCanvasSyncForTests,
} from './canvasStore';
import { useCanvasSyncStore } from './canvasSyncStore';

import type * as apiModule from '../api';
import type * as canvasApiModule from '../api/canvas';
import type * as canvasSyncApiModule from '@/api/canvasSync';
import type { Node } from '@xyflow/react';

/**
 * What an incoming change may do to a node this page holds unsaved content
 * for, through the real sync store, canvas store, content queue and
 * change-review store. Only the HTTP API, the stream transport and the toast
 * surface are stand-ins.
 */

const SPACE = 'space-remote-protection';
const X = 'node-protected-x';
const Y = 'node-protected-y';
const THREAD = 'thread-agent';
/** A revision no hash of a node in an update would give. */
const STORED = 'stored-by-the-server';

const note = (id: string, x: number): Node => ({
  id,
  type: 'note',
  position: { x, y: 0 },
  style: { width: 300, height: 200 },
  data: {
    type: 'note',
    label: `Label ${id}`,
    labelSource: 'user',
    content: `Body ${id}`,
    heightMode: 'fixed',
    style: { accent: 'white' },
  },
});

const state = () => useCanvasStore.getState();
const node = (id: string): Node | undefined =>
  state().nodes.find((candidate) => candidate.id === id);
const data = (id: string): Record<string, unknown> =>
  (node(id)?.data ?? {}) as Record<string, unknown>;

const NO_EFFECTS = {
  mutatedNodeIds: [],
  deletedNodeIds: [],
  contentEditedNodeIds: [],
  deferredFitFrameIds: [],
};

const encoder = new TextEncoder();
let push: (type: string, payload: unknown) => Promise<void>;

/** Open the Space's stream; `push` then delivers one event at a time. */
async function connect(): Promise<void> {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)));
  push = async (type, payload) => {
    controller.enqueue(
      encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`),
    );
    await vi.advanceTimersByTimeAsync(50);
  };
  useCanvasSyncStore.getState().connect(SPACE);
  await vi.advanceTimersByTimeAsync(50);
  await push('snapshot', { version: state().version });
}

/** An agent's `update` that changes `fields` of X's data, filed under THREAD. */
function agentChanges(
  fields: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  nodeFields: Record<string, unknown> = {},
): Promise<void> {
  return push('update', {
    fromVersion: state().version,
    toVersion: state().version + 1,
    deltas: [
      {
        type: 'REPLACE_NODE',
        nodeType: 'note',
        prev: {
          id: X,
          ...storedNodeFields(nodeFields),
          data: storedData(fields),
        },
        next: { id: X, ...nodeFields, data: fields },
      },
    ],
    pendingEffects: NO_EFFECTS,
    source: 'agent',
    threadId: THREAD,
    changes: [
      {
        id: 'change-1',
        nodeId: X,
        kind: 'update',
        label: `Label ${X}`,
        revertDeltas: [],
      },
    ],
    ...extra,
  });
}

/** What the server held, before an agent's change, for the data keys it names. */
function storedData(fields: Record<string, unknown>): Record<string, unknown> {
  const stored = note(X, 0).data as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(fields).map((key) => [key, stored[key]]),
  );
}

/** The same for the top-level node fields it names. */
function storedNodeFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const stored = note(X, 0) as unknown as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(fields).map((key) => [key, stored[key]]),
  );
}

/** The server accepts a body save only on the revision it holds. */
function serverHolds(rev: string): void {
  api.putNodeContent.mockImplementation(
    async (_canvasId: string, nodeId: string, body: { expectRev?: string }) => {
      if (body.expectRev !== undefined && body.expectRev !== rev)
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

const toastsWith = (text: string) =>
  vi
    .mocked(toast)
    .mock.calls.filter(([message]) => String(message).includes(text));
const conflictToasts = () =>
  vi
    .mocked(toast)
    .mock.calls.filter(
      ([, options]) => options?.secondaryAction?.label === 'Keep mine',
    );
const savesOf = (id: string) =>
  api.putNodeContent.mock.calls
    .filter(([, nodeId]) => nodeId === id)
    .map(([, , body]) => body as Record<string, unknown>);

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetCanvasSyncForTests();
  useCanvasSyncStore.setState({ canvasId: null });
  useAcpThreadChangesStore.setState({ byThread: {}, conflictedByThread: {} });
  useCanvasPresenceStore.setState({ localEditingNodeId: null });
  canvasHistoryManager.activate(SPACE, true);
  api.postCanvasExecute.mockImplementation(() => new Promise(() => {}));
  api.preprocessNode.mockResolvedValue({ success: true });
  api.postCanvasEvents.mockResolvedValue({ success: true });
  api.putNodeContent.mockImplementation(
    async (_canvasId: string, nodeId: string, body: { content?: string }) => ({
      nodeId,
      label: null,
      rev: nodeRevisionOf({ content: body.content ?? '' }),
    }),
  );
  // The content queue outlives a test: forget what earlier ones left.
  useCanvasStore.setState({ nodes: [], isLoading: false });
  await vi.advanceTimersByTimeAsync(10_000);
  state()._setStateRaw({
    canvasId: SPACE,
    canvasTitle: 'Protection',
    nodes: [note(X, 0), note(Y, 400)],
    edges: [],
    version: 1,
    isLoading: false,
    canUndo: false,
    canRedo: false,
  });
  // The page shows what the server holds for X, with its revision.
  api.getNodeContent.mockResolvedValue({
    nodeId: X,
    type: 'note',
    label: `Label ${X}`,
    labelSource: 'user',
    content: `Body ${X}`,
    rev: nodeRevisionOf({ content: `Body ${X}` }),
  });
  await adoptRemoteNodeContent(SPACE, [X]);
  vi.clearAllMocks();
  api.postCanvasExecute.mockImplementation(() => new Promise(() => {}));
  api.getNodeContent.mockResolvedValue(null);
  expect(state().pendingContentNodeIds()).toEqual([]);
  await connect();
});

afterEach(async () => {
  useCanvasSyncStore.getState().disconnect();
  useCanvasStore.setState({ nodes: [], isLoading: false });
  await vi.advanceTimersByTimeAsync(10_000);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a body being typed here, and a change arriving from an agent', () => {
  it('keeps the text when the agent rewrites the body, tells the person, marks the change card, and saves over the agent’s revision', async () => {
    serverHolds(STORED);
    state().updateNodeData(X, { content: 'Typing' });

    await agentChanges(
      { content: 'Agent text' },
      { nodeContentRevisions: { [X]: STORED } },
    );

    expect(data(X).content).toBe('Typing');
    expect(state().version).toBe(2);
    // The person is told at that moment…
    const notices = toastsWith('your version was kept');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.[1]).toMatchObject({ tone: 'warning', duration: 0 });
    // …and the conversation's card marks the row and still holds the
    // agent's change for inspection.
    const changes = useAcpThreadChangesStore.getState();
    expect(changes.conflictedByThread[THREAD]).toEqual([X]);
    expect(changes.byThread[THREAD]).toHaveLength(1);

    // Local-first: the text is saved on the agent's revision, unprompted.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(savesOf(X)).toHaveLength(1);
    expect(savesOf(X)[0]).toMatchObject({
      content: 'Typing',
      expectRev: STORED,
    });
    expect(conflictToasts()).toHaveLength(0);
    expect(state().pendingContentNodeIds()).toEqual([]);
  });

  it('applies a move and a recolour of that note at once, without a notice, and the body is saved as usual', async () => {
    state().updateNodeData(X, { content: 'Typing' });

    await agentChanges(
      { style: { accent: 'teal' } },
      {},
      { position: { x: 90, y: 40 } },
    );

    expect(node(X)?.position).toEqual({ x: 90, y: 40 });
    expect(data(X).style).toEqual({ accent: 'teal' });
    expect(data(X).content).toBe('Typing');
    expect(toastsWith('your version was kept')).toHaveLength(0);
    expect(
      useAcpThreadChangesStore.getState().conflictedByThread[THREAD],
    ).toEqual([]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(savesOf(X)).toHaveLength(1);
    expect(savesOf(X)[0]).toMatchObject({
      content: 'Typing',
      expectRev: nodeRevisionOf({ content: `Body ${X}` }),
    });
    expect(conflictToasts()).toHaveLength(0);
  });

  it('shows a title the agent gave the note while its body is being typed', async () => {
    state().updateNodeData(X, { content: 'Typing' });

    await agentChanges(
      { label: 'Agent title', labelSource: 'agent' },
      {
        nodeContentRevisions: { [X]: nodeRevisionOf({ content: `Body ${X}` }) },
      },
    );

    // Only the body is this page's: the title is not held and is shown.
    expect(data(X).content).toBe('Typing');
    expect(data(X)).toMatchObject({
      label: 'Agent title',
      labelSource: 'agent',
    });
    expect(toastsWith('your version was kept')).toHaveLength(0);
    expect(
      useAcpThreadChangesStore.getState().conflictedByThread[THREAD],
    ).toEqual([]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(savesOf(X)).toHaveLength(1);
    expect(savesOf(X)[0]).toMatchObject({
      content: 'Typing',
      expectRev: nodeRevisionOf({ content: `Body ${X}` }),
    });
    // The body save does not write this page's copy of the title back.
    expect(savesOf(X)[0]).not.toHaveProperty('label');
    expect(conflictToasts()).toHaveLength(0);
  });

  it('keeps a title being saved here and shows the body the agent wrote', async () => {
    serverHolds(STORED);
    state().updateNodeData(X, { label: 'My title', labelSource: 'user' });

    await agentChanges(
      { content: 'Agent text' },
      { nodeContentRevisions: { [X]: STORED } },
    );

    // Only the title is this page's: the body is not held and is shown,
    // with the revision the server stored for it.
    expect(data(X).label).toBe('My title');
    expect(data(X).content).toBe('Agent text');
    expect(toastsWith('your version was kept')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(savesOf(X)).toHaveLength(1);
    expect(savesOf(X)[0]).toMatchObject({
      label: 'My title',
      labelSource: 'user',
    });
    // A rename quotes no revision: the body is not its concern.
    expect(savesOf(X)[0]).not.toHaveProperty('expectRev');
    // The title save does not write the body back.
    expect(savesOf(X)[0]).not.toHaveProperty('content');
    expect(conflictToasts()).toHaveLength(0);
    expect(data(X).content).toBe('Agent text');
  });

  it('keeps a note the agent deletes for as long as it is being edited, says so, and sends nothing for it', async () => {
    state().updateNodeData(X, { content: 'Typing' });
    useCanvasPresenceStore.setState({ localEditingNodeId: X });

    await push('update', {
      fromVersion: state().version,
      toVersion: state().version + 1,
      deltas: [{ type: 'DELETE_NODE', node: { id: X, type: 'note' } }],
      pendingEffects: { ...NO_EFFECTS, deletedNodeIds: [X] },
      source: 'agent',
      threadId: THREAD,
      changes: [
        {
          id: 'change-1',
          nodeId: X,
          kind: 'delete',
          label: `Label ${X}`,
          revertDeltas: [],
        },
      ],
    });

    // The node is not taken away from under the caret.
    expect(data(X).content).toBe('Typing');
    expect(state().version).toBe(2);
    expect(
      useAcpThreadChangesStore.getState().conflictedByThread[THREAD],
    ).toEqual([X]);
    // One notice, about the deletion; not the "your version was kept" one.
    expect(
      toastsWith('was deleted elsewhere while you are editing'),
    ).toHaveLength(1);
    expect(toastsWith('your version was kept')).toHaveLength(0);

    // What is typed meanwhile stays on the page and is not sent: the server
    // has no node to write it to.
    state().updateNodeData(X, { content: 'Typing more' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(node(X)).toBeDefined();
    expect(savesOf(X)).toHaveLength(0);

    // Leaving the editor lets the deletion through; the text is offered.
    useCanvasPresenceStore.setState({ localEditingNodeId: null });
    await vi.advanceTimersByTimeAsync(10);
    expect(node(X)).toBeUndefined();
    expect(node(Y)).toBeDefined();
    const removed = toastsWith('has been removed from this Space');
    expect(removed).toHaveLength(1);
    removed[0]?.[1]?.action?.onClick();
    expect(copyToClipboard).toHaveBeenCalledWith('Typing more');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(savesOf(X)).toHaveLength(0);
    expect(state().pendingContentNodeIds()).toEqual([]);
  });

  it('removes a note the agent deletes at once when it is not being edited, and offers text that was not saved', async () => {
    state().updateNodeData(X, { content: 'Typed a moment ago' });

    await push('update', {
      fromVersion: state().version,
      toVersion: state().version + 1,
      deltas: [{ type: 'DELETE_NODE', node: { id: X, type: 'note' } }],
      pendingEffects: { ...NO_EFFECTS, deletedNodeIds: [X] },
      source: 'agent',
    });

    expect(node(X)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(savesOf(X)).toHaveLength(0);
  });
});

describe('a body being typed here, and another person’s save of that note', () => {
  /** Another page saved X: the event, and what a fetch then returns. */
  async function otherPageSaved(fields: {
    content: string;
    label: string;
  }): Promise<void> {
    api.getNodeContent.mockResolvedValue({
      nodeId: X,
      type: 'note',
      labelSource: 'user',
      ...fields,
      rev: STORED,
    });
    await push('invalidate', { nodeIds: [X] });
  }

  it('keeps the text, shows the other title, asks when its save is refused, and Keep mine saves the text over the other body', async () => {
    serverHolds(STORED);
    state().updateNodeData(X, { content: 'Typing' });

    await otherPageSaved({ content: 'Their text', label: 'Their title' });

    expect(api.getNodeContent).toHaveBeenCalledTimes(1);
    expect(data(X).content).toBe('Typing');
    // The title is not this page's change: it is shown at once.
    expect(data(X).label).toBe('Their title');
    expect(toastsWith('your version was kept')).toHaveLength(0);

    // Another person's save is not rebased over: the choice is the user's.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(savesOf(X)).toHaveLength(1);
    expect(conflictToasts()).toHaveLength(1);
    expect(data(X).content).toBe('Typing');

    const keepMine = conflictToasts()[0]?.[1]?.secondaryAction?.onClick;
    keepMine?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(savesOf(X)).toHaveLength(2);
    // Keep mine is about the body: the request carries nothing else, so the
    // other person's title stands on the server and on this page.
    expect(savesOf(X)[1]).toMatchObject({
      content: 'Typing',
      expectRev: STORED,
    });
    expect(savesOf(X)[1]).not.toHaveProperty('label');
    expect(savesOf(X)[1]).not.toHaveProperty('labelSource');
    expect(savesOf(X)[1]).not.toHaveProperty('summary');
    expect(data(X).label).toBe('Their title');
  });
});
