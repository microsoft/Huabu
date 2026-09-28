// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import useCanvasStore from '@/store/canvasStore';
import { selectThreadMessages, useChatStore } from '@/store/chatStore';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import {
  claimAgentStream,
  hasAgentStreamClaim,
} from './agentStreamCoordinator';
import {
  captureAgentTurnSources,
  dispatchAgentTurn,
  handleStreamEvent,
  observeAgentTurnAcceptance,
  prepareAgentTurn,
  prepareAgentTurnRetry,
  resetAgentTurnAcceptanceObserversForTests,
  stopAgentTurn,
} from './agentTurnController';
import { useAgentStream, type UseAgentStreamReturn } from './useAgentStream';

import type { ChatSession } from './useChatSession';
import type { AgentStreamCallbacks } from '@/api/agent';
import type { ChatAttachment } from '@huabu/shared';

const mocks = vi.hoisted(() => ({
  stream: vi.fn(),
  stop: vi.fn(),
  save: vi.fn(),
  validate: vi.fn(),
}));

vi.mock('@/api/agent', () => ({
  agentApi: { streamMessage: mocks.stream, stopThread: mocks.stop },
}));
vi.mock('@/store/canvasStore', async (original) => ({
  ...((await original()) as object),
  saveCanvasForSubmission: mocks.save,
}));
vi.mock('@/store/conversationOwner', async (original) => ({
  ...((await original()) as object),
  validateConversationView: mocks.validate,
}));

const session: ChatSession = {
  canvasId: 'canvas-1',
  ownerCanvasId: 'canvas-1',
  threadId: 'thread-1',
  conversationView: null,
};
const questionSession: ChatSession = {
  ...session,
  conversationView: {
    presentationAnchor: { canvasId: 'canvas-1', nodeId: 'question-1' },
    conversationOwner: {
      canvasId: 'canvas-1',
      nodeId: 'question-1',
      threadId: 'thread-1',
    },
  },
};
let root: Root | undefined;
let container: HTMLDivElement | undefined;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function request(inputKind: 'text' | 'ink-intent' = 'text', owner = session) {
  return prepareAgentTurn({
    session: owner,
    inputKind,
    content: inputKind === 'text' ? 'Hello' : '',
    mode: 'operate',
    sources: captureAgentTurnSources(owner),
  });
}

it('records genuine completion by owner thread, not tool updates or repeated done events', () => {
  const ctx = { threadId: 'completed-owner', assistantId: 'assistant-1' };
  handleStreamEvent({ type: 'text_delta', data: { content: 'Answer' } }, ctx);
  handleStreamEvent(
    {
      type: 'tool_call_update',
      data: { toolCallId: 'tool-1', status: 'completed' },
    },
    ctx,
  );
  expect(
    useChatStore.getState().threadsById[ctx.threadId]?.completedTurnId,
  ).toBeUndefined();
  handleStreamEvent({ type: 'done', data: { message: 'Answer' } }, ctx);
  expect(
    useChatStore.getState().threadsById[ctx.threadId]?.completedTurnId,
  ).toBe('assistant-1');
  expect(
    useChatStore.getState().threadsById['other-thread']?.completedTurnId,
  ).toBeUndefined();
  const snapshot = useChatStore.getState();
  handleStreamEvent({ type: 'done', data: { message: 'Answer' } }, ctx);
  expect(useChatStore.getState()).toBe(snapshot);
});

beforeEach(() => {
  vi.clearAllMocks();
  resetAgentTurnAcceptanceObserversForTests();
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.stop.mockReset().mockResolvedValue({
    stopped: true,
    acceptance: null,
  });
  mocks.validate.mockReset().mockResolvedValue(undefined);
  mocks.stream
    .mockReset()
    .mockImplementation(
      async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) => {
        callbacks.onAccepted?.({ threadId: 'thread-1', turnStartSeq: 5 });
        callbacks.onEvent({ type: 'text_delta', data: { content: 'Answer' } });
        callbacks.onComplete();
      },
    );
  useChatStore.setState({
    threadsById: {},
    bindingByThread: {},
    settingsByThread: {},
    lastActionByThread: {},
    ephemeralMetadataThreads: {},
    ephemeralSettingsThreads: {},
    selectionAttachment: null,
  });
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: 'canvas-1',
    isSaving: false,
    pendingSave: false,
    versionConflict: false,
    nodes: [
      {
        id: 'note-1',
        type: 'note',
        selected: true,
        position: { x: 0, y: 0 },
        data: { content: 'Source' },
      },
      { id: 'sketch-1', type: 'sketch', position: { x: 0, y: 0 }, data: {} },
    ],
    edges: [],
  });
  useGesturePreviewStore.setState({
    sketchStrokeSelection: { 'sketch-1': ['stroke-1'] },
  });
  vi.spyOn(useCanvasStore.getState(), 'flushCanvasEvents').mockResolvedValue();
  vi.spyOn(useCanvasStore.getState(), 'updateNodeData').mockImplementation(
    () => {},
  );
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe('shared Agent turn input', () => {
  it('deduplicates Frame-nested Ink while excluding its Question anchor', () => {
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [
        {
          id: 'frame-1',
          type: 'frame',
          selected: true,
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: 'question-1',
          type: 'question',
          parentId: 'frame-1',
          position: { x: 10, y: 10 },
          data: { threadId: 'thread-1' },
        },
        {
          id: 'sketch-1',
          type: 'sketch',
          parentId: 'frame-1',
          position: { x: 20, y: 20 },
          data: {},
        },
      ],
    });

    const sources = captureAgentTurnSources(questionSession, {
      nodeIds: ['frame-1'],
      strokeSelection: { 'sketch-1': ['stroke-1'] },
    });

    expect(sources.canvasContext.selectedNodes).toEqual([
      {
        id: 'frame-1',
        type: 'frame',
        children: [
          {
            id: 'sketch-1',
            type: 'sketch',
            strokeIds: ['stroke-1'],
          },
        ],
      },
    ]);
  });

  it('projects inferred Ink intent without rendering its tool call', () => {
    useChatStore.getState().addMessage('thread-1', {
      id: 'ink-user',
      role: 'user',
      content: '',
      inputKind: 'ink-intent',
    });

    handleStreamEvent(
      {
        type: 'tool_call',
        data: {
          toolCallId: 'intent-1',
          title: 'report_ink_intent',
          status: 'pending',
          rawInput: {
            status: 'inferred',
            text: 'Expand the third comparison step',
          },
          internalToolName: 'report_ink_intent',
        },
      },
      { threadId: 'thread-1', assistantId: 'assistant-1' },
    );
    handleStreamEvent(
      {
        type: 'tool_call_update',
        data: {
          toolCallId: 'intent-1',
          status: 'completed',
          rawOutput: '{}',
        },
      },
      { threadId: 'thread-1', assistantId: 'assistant-1' },
    );

    expect(selectThreadMessages(useChatStore.getState(), 'thread-1')).toEqual([
      expect.objectContaining({
        id: 'ink-user',
        inferredIntent: 'Expand the third comparison step',
      }),
    ]);
  });

  it('keeps the Ink fallback when intent reporting fails', () => {
    useChatStore.getState().addMessage('thread-1', {
      id: 'ink-user',
      role: 'user',
      content: '',
      inputKind: 'ink-intent',
    });
    handleStreamEvent(
      {
        type: 'tool_call',
        data: {
          toolCallId: 'intent-failed',
          title: 'report_ink_intent',
          status: 'pending',
          rawInput: { status: 'inferred', text: 'Do not display' },
          internalToolName: 'report_ink_intent',
        },
      },
      { threadId: 'thread-1', assistantId: 'assistant-1' },
    );
    handleStreamEvent(
      {
        type: 'tool_call_update',
        data: { toolCallId: 'intent-failed', status: 'failed' },
      },
      { threadId: 'thread-1', assistantId: 'assistant-1' },
    );

    expect(selectThreadMessages(useChatStore.getState(), 'thread-1')).toEqual([
      expect.not.objectContaining({ inferredIntent: expect.anything() }),
    ]);
  });

  it('preserves text, explicit extras, settings and captured sources across async saving', async () => {
    const gate = deferred();
    mocks.save.mockReturnValueOnce(gate.promise);
    useChatStore.getState().setThreadSettings(session.threadId, {
      modelId: 'model-1',
      reasoningEffort: 'high',
    });
    const prepared = request();
    prepared.invokedSkills = ['review'];
    const running = dispatchAgentTurn(prepared);
    useCanvasStore.getState()._setStateNoAutosave({ nodes: [] });
    useGesturePreviewStore.setState({ sketchStrokeSelection: {} });
    gate.resolve();
    const result = await running;
    expect(result.status).toBe('completed');
    expect(mocks.stream).toHaveBeenCalledWith(
      'Hello',
      'thread-1',
      'operate',
      expect.anything(),
      expect.objectContaining({
        inputKind: 'text',
        modelId: 'model-1',
        reasoningEffort: 'high',
        invokedSkills: ['review'],
        canvasContext: {
          selectedNodes: [
            expect.objectContaining({ id: 'note-1' }),
            expect.objectContaining({
              id: 'sketch-1',
              strokeIds: ['stroke-1'],
            }),
          ],
        },
      }),
    );
    expect(
      selectThreadMessages(useChatStore.getState(), session.threadId)[0],
    ).toMatchObject({
      role: 'user',
      selectedNodeIds: ['note-1', 'sketch-1'],
      selectedStrokeIds: [{ nodeId: 'sketch-1', strokeIds: ['stroke-1'] }],
    });
  });

  it('sends Ink without consuming same-thread drafts, uploads, excerpts or skills', async () => {
    const attachment = {
      id: 'upload',
      type: 'text',
      content: 'private draft',
    } as unknown as ChatAttachment;
    useChatStore.getState().setDraft(session.threadId, 'Unsent draft');
    useChatStore.getState().addPendingAttachment(session.threadId, attachment);
    useChatStore.getState().setSelectionAttachment(attachment);
    await dispatchAgentTurn(request('ink-intent'));
    expect(mocks.stream.mock.calls[0][0]).toBe('');
    expect(mocks.stream.mock.calls[0][4]).toMatchObject({
      inputKind: 'ink-intent',
      attachments: undefined,
      invokedSkills: undefined,
    });
    const state = useChatStore.getState();
    expect(state.threadsById[session.threadId].draft).toBe('Unsent draft');
    expect(state.threadsById[session.threadId].pendingAttachments).toEqual([
      attachment,
    ]);
    expect(state.selectionAttachment).toBe(attachment);
  });

  it('preserves a selectable Question external binding for Ink', async () => {
    const binding = {
      kind: 'external' as const,
      profileId: 'profile-1',
      alias: 'External Agent',
    };
    useChatStore.getState().setAgentBinding(session.threadId, binding);
    const prepared = request('ink-intent', questionSession);

    expect(prepared.agentBinding).toEqual(binding);
    await dispatchAgentTurn(prepared);

    expect(mocks.stream).toHaveBeenCalledWith(
      '',
      'thread-1',
      'operate',
      expect.anything(),
      expect.objectContaining({ agentBinding: binding }),
    );
  });

  it('retries Ink from the stored typed input instead of current composer state', async () => {
    const attachment = {
      id: 'source-file',
      type: 'text',
      content: 'submitted source',
    } as unknown as ChatAttachment;
    const prepared = prepareAgentTurnRetry(
      session,
      {
        id: 'user-1',
        role: 'user',
        content: '',
        inputKind: 'ink-intent',
        attachments: [attachment],
        selectedNodeIds: ['note-1', 'sketch-1'],
        selectedStrokeIds: [{ nodeId: 'sketch-1', strokeIds: ['stroke-1'] }],
        invokedSkills: ['review'],
      },
      'operate',
    );

    await dispatchAgentTurn(prepared);

    expect(mocks.stream).toHaveBeenCalledWith(
      '',
      'thread-1',
      'operate',
      expect.anything(),
      expect.objectContaining({
        inputKind: 'ink-intent',
        attachments: [attachment],
        invokedSkills: ['review'],
        canvasContext: {
          selectedNodes: expect.arrayContaining([
            expect.objectContaining({ id: 'note-1' }),
            expect.objectContaining({
              id: 'sketch-1',
              strokeIds: ['stroke-1'],
            }),
          ]),
        },
      }),
    );
  });

  it('notifies acceptance only through the transport acceptance callback', async () => {
    const accepted = vi.fn();
    mocks.stream.mockImplementationOnce(
      async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) => {
        callbacks.onEvent({
          type: 'meta',
          data: { threadId: 'thread-1', mode: 'operate' },
        });
        expect(accepted).not.toHaveBeenCalled();
        callbacks.onAccepted?.({ threadId: 'thread-1', turnStartSeq: 8 });
        expect(accepted).toHaveBeenCalledWith({
          threadId: 'thread-1',
          turnStartSeq: 8,
        });
        callbacks.onComplete();
      },
    );
    await dispatchAgentTurn(request('ink-intent'), { onAccepted: accepted });
  });

  it('classifies an error after durable acceptance as a runtime failure', async () => {
    mocks.stream.mockImplementationOnce(
      async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) => {
        callbacks.onAccepted?.({ threadId: 'thread-1', turnStartSeq: 8 });
        callbacks.onError(new Error('Agent failed after starting'));
      },
    );

    await expect(
      dispatchAgentTurn(request('ink-intent')),
    ).resolves.toMatchObject({
      status: 'failed',
      accepted: { threadId: 'thread-1', turnStartSeq: 8 },
    });
  });

  it('retains the acceptance observer after an ambiguous transport failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.stream.mockRejectedValueOnce(new Error('Connection lost'));
    const accepted = vi.fn();

    await expect(
      dispatchAgentTurn(request('ink-intent'), { onAccepted: accepted }),
    ).resolves.toMatchObject({ status: 'unknown' });

    const acceptance = { threadId: 'thread-1', turnStartSeq: 12 };
    observeAgentTurnAcceptance('canvas-1', acceptance);
    observeAgentTurnAcceptance('canvas-1', acceptance);
    expect(accepted).toHaveBeenCalledExactlyOnceWith(acceptance);
  });

  it('blocks same-thread replacement until unknown acceptance is reconciled', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.stream.mockRejectedValueOnce(new Error('Connection lost'));
    const accepted = vi.fn();

    await expect(
      dispatchAgentTurn(request('ink-intent'), { onAccepted: accepted }),
    ).resolves.toMatchObject({ status: 'unknown' });

    await expect(
      dispatchAgentTurn(request('ink-intent')),
    ).resolves.toMatchObject({
      status: 'busy',
      error: {
        message:
          'The previous Agent turn is still awaiting acceptance reconciliation',
      },
    });
    expect(mocks.stream).toHaveBeenCalledTimes(1);

    observeAgentTurnAcceptance('canvas-1', {
      threadId: 'thread-1',
      turnStartSeq: 12,
    });
    expect(accepted).toHaveBeenCalledOnce();

    await expect(
      dispatchAgentTurn(request('ink-intent')),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(mocks.stream).toHaveBeenCalledTimes(2);
  });

  it('does not deliver a duplicate older acceptance to a newer turn', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.stream.mockRejectedValueOnce(new Error('Connection lost'));
    const olderAccepted = vi.fn();

    await dispatchAgentTurn(request('ink-intent'), {
      onAccepted: olderAccepted,
    });
    const olderAcceptance = { threadId: 'thread-1', turnStartSeq: 20 };
    observeAgentTurnAcceptance('canvas-1', olderAcceptance);
    expect(olderAccepted).toHaveBeenCalledExactlyOnceWith(olderAcceptance);

    const newerAccepted = vi.fn();
    mocks.stream.mockImplementationOnce(
      async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) => {
        observeAgentTurnAcceptance('canvas-1', olderAcceptance);
        expect(newerAccepted).not.toHaveBeenCalled();
        callbacks.onAccepted?.({ threadId: 'thread-1', turnStartSeq: 21 });
        callbacks.onComplete();
      },
    );

    await expect(
      dispatchAgentTurn(request('ink-intent'), {
        onAccepted: newerAccepted,
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      accepted: { threadId: 'thread-1', turnStartSeq: 21 },
    });
    expect(olderAccepted).toHaveBeenCalledOnce();
    expect(newerAccepted).toHaveBeenCalledExactlyOnceWith({
      threadId: 'thread-1',
      turnStartSeq: 21,
    });
  });

  it('does not POST after a rejected save or leak its preparation claim', async () => {
    mocks.save.mockRejectedValueOnce(new Error('save conflict'));
    const result = await dispatchAgentTurn(request('ink-intent'));
    expect(result).toMatchObject({
      status: 'rejected',
      error: { message: 'save conflict' },
    });
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(hasAgentStreamClaim('canvas-1', 'thread-1')).toBe(false);
  });

  it('leaves server-owned Question lifecycle untouched when preparation saving fails', async () => {
    mocks.save.mockRejectedValueOnce(new Error('save conflict'));
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [
        {
          id: 'question-1',
          type: 'question',
          position: { x: 0, y: 0 },
          data: {
            content: '',
            threadId: 'thread-1',
            status: 'idle',
            pendingInkIntentLabel: true,
          },
        },
        {
          id: 'sketch-1',
          type: 'sketch',
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
    });

    const result = await dispatchAgentTurn(
      request('ink-intent', questionSession),
    );

    expect(result.status).toBe('rejected');
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it('does not perform a second client lifecycle save before POST', async () => {
    mocks.save
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('lifecycle save conflict'));

    const result = await dispatchAgentTurn(request('ink-intent'));

    expect(result.status).toBe('completed');
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(mocks.stream).toHaveBeenCalledOnce();
    expect(hasAgentStreamClaim('canvas-1', 'thread-1')).toBe(false);
  });

  it('stops a Question while its preparation save is pending', async () => {
    const preparationSave = deferred();
    mocks.save.mockReturnValueOnce(preparationSave.promise);
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [
        {
          id: 'question-1',
          type: 'question',
          position: { x: 0, y: 0 },
          data: { content: '', threadId: 'thread-1', status: 'idle' },
        },
        {
          id: 'sketch-1',
          type: 'sketch',
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
    });

    const running = dispatchAgentTurn(request('ink-intent', questionSession));
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());

    stopAgentTurn(questionSession);
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce());
    preparationSave.resolve();

    await expect(running).resolves.toMatchObject({ status: 'stopped' });
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(hasAgentStreamClaim('canvas-1', 'thread-1')).toBe(false);
  });

  it('claims before validation so another surface cannot POST or attach', async () => {
    const gate = deferred();
    mocks.save.mockReturnValueOnce(gate.promise);
    const prepared = request('ink-intent');
    const running = dispatchAgentTurn(prepared);
    expect((await dispatchAgentTurn(prepared)).status).toBe('busy');
    expect(claimAgentStream('canvas-1', 'thread-1', 'attach')).toBeNull();
    gate.resolve();
    await running;
    expect(mocks.stream).toHaveBeenCalledTimes(1);
  });

  it('allows node-less source-less text', async () => {
    useCanvasStore.getState()._setStateNoAutosave({ nodes: [] });
    useGesturePreviewStore.setState({ sketchStrokeSelection: {} });
    await dispatchAgentTurn(request());
    expect(mocks.stream.mock.calls[0][4].canvasContext).toEqual({
      selectedNodes: [],
    });
  });

  it('keeps a text run alive after Chat unmount and permits a new Chat to stop it', async () => {
    let hook!: UseAgentStreamReturn;
    function Harness() {
      hook = useAgentStream(session);
      return null;
    }
    const started = deferred();
    mocks.stream.mockImplementationOnce(
      async (
        _content,
        _thread,
        _mode,
        callbacks: AgentStreamCallbacks,
        options: { signal: AbortSignal },
      ) => {
        started.resolve();
        await new Promise<void>((resolve) =>
          options.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        callbacks.onComplete();
      },
    );
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(createElement(Harness)));
    let running!: Promise<void>;
    await act(async () => {
      running = hook.startStream('Hello', 'operate');
      await started.promise;
    });
    act(() => root?.unmount());
    root = undefined;
    expect(mocks.stream.mock.calls[0][4].signal.aborted).toBe(false);
    stopAgentTurn(session);
    await running;
    expect(mocks.stop).toHaveBeenCalledWith('thread-1', 'canvas-1');
    expect(hasAgentStreamClaim('canvas-1', 'thread-1')).toBe(false);
  });

  it('applies stop acceptance before aborting the local stream', async () => {
    const started = deferred();
    const accepted = vi.fn();
    mocks.stop.mockResolvedValueOnce({
      stopped: true,
      acceptance: { threadId: 'thread-1', turnStartSeq: 9 },
    });
    mocks.stream.mockImplementationOnce(
      async (
        _content,
        _thread,
        _mode,
        callbacks: AgentStreamCallbacks,
        options: { signal: AbortSignal },
      ) => {
        started.resolve();
        await new Promise<void>((resolve) =>
          options.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        callbacks.onComplete();
      },
    );
    const running = dispatchAgentTurn(request('ink-intent'), {
      onAccepted: accepted,
    });
    await started.promise;

    stopAgentTurn(session);

    await expect(running).resolves.toMatchObject({
      status: 'stopped',
      accepted: { threadId: 'thread-1', turnStartSeq: 9 },
    });
    expect(accepted).toHaveBeenCalledExactlyOnceWith({
      threadId: 'thread-1',
      turnStartSeq: 9,
    });
  });

  it('releases an unknown acceptance observer after a definitive pre-acceptance stop', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.stream.mockRejectedValueOnce(new Error('Connection lost'));
    const acceptanceRejected = vi.fn();

    await expect(
      dispatchAgentTurn(request('ink-intent'), {
        onAcceptanceRejected: acceptanceRejected,
      }),
    ).resolves.toMatchObject({ status: 'unknown' });

    mocks.stop.mockResolvedValueOnce({ stopped: true, acceptance: null });
    stopAgentTurn(session);
    await vi.waitFor(() => expect(acceptanceRejected).toHaveBeenCalledOnce());

    await expect(
      dispatchAgentTurn(request('ink-intent')),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(mocks.stream).toHaveBeenCalledTimes(2);
  });

  it('keeps monitoring when the stop outcome is unknown', async () => {
    const started = deferred();
    const finish = deferred();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mocks.stop.mockRejectedValueOnce(new Error('offline'));
    mocks.stream.mockImplementationOnce(
      async (
        _content,
        _thread,
        _mode,
        callbacks: AgentStreamCallbacks,
        options: { signal: AbortSignal },
      ) => {
        started.resolve();
        await finish.promise;
        expect(options.signal.aborted).toBe(false);
        callbacks.onComplete();
      },
    );
    const running = dispatchAgentTurn(request('ink-intent'));
    await started.promise;

    stopAgentTurn(session);
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledOnce());

    expect(hasAgentStreamClaim('canvas-1', 'thread-1')).toBe(true);
    expect(
      selectThreadMessages(useChatStore.getState(), 'thread-1').some(
        (message) =>
          message.role === 'status' && message.status === 'interrupted',
      ),
    ).toBe(false);
    finish.resolve();
    await expect(running).resolves.toMatchObject({ status: 'completed' });
    expect(hasAgentStreamClaim('canvas-1', 'thread-1')).toBe(false);
  });

  it('keeps monitoring when the server reports no active turn to stop', async () => {
    const started = deferred();
    const finish = deferred();
    mocks.stop.mockResolvedValueOnce({ stopped: false, acceptance: null });
    mocks.stream.mockImplementationOnce(
      async (
        _content,
        _thread,
        _mode,
        callbacks: AgentStreamCallbacks,
        options: { signal: AbortSignal },
      ) => {
        started.resolve();
        await finish.promise;
        expect(options.signal.aborted).toBe(false);
        callbacks.onComplete();
      },
    );
    const running = dispatchAgentTurn(request('ink-intent'));
    await started.promise;

    stopAgentTurn(session);
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce());

    expect(hasAgentStreamClaim('canvas-1', 'thread-1')).toBe(true);
    expect(
      selectThreadMessages(useChatStore.getState(), 'thread-1').some(
        (message) =>
          message.role === 'status' && message.status === 'interrupted',
      ),
    ).toBe(false);
    finish.resolve();
    await expect(running).resolves.toMatchObject({ status: 'completed' });
  });
});
