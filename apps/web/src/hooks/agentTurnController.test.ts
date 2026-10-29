// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/_client';
import { useAcpThreadChangesStore } from '@/store/acpThreadChangesStore';
import useCanvasStore from '@/store/canvasStore';
import {
  selectThreadExcludeCanvasSelection,
  selectThreadMessages,
  useChatStore,
} from '@/store/chatStore';
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
vi.mock('@/api/conversationTitles', () => ({
  queryConversationTitles: vi.fn(async () => ({ titles: {} })),
  setConversationTitle: vi.fn(),
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

function request(
  inputKind: 'text' | 'ink-intent' | 'selection-intent' = 'text',
  owner = session,
) {
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

describe('Ink interpretation lifecycle', () => {
  const ctx = {
    threadId: 'thread-1',
    assistantId: 'assistant-1',
    userMessageId: 'ink-user',
  };
  const startReport = (
    id: string,
    rawInput: unknown,
    internalToolName: string | undefined = 'report_ink_intent',
  ) =>
    handleStreamEvent(
      {
        type: 'tool_call',
        data: {
          toolCallId: id,
          title: 'report_ink_intent',
          internalToolName,
          status: 'pending',
          rawInput,
        },
      },
      ctx,
    );
  const updateReport = (
    id: string,
    data: {
      status?: 'pending' | 'in_progress' | 'completed' | 'failed';
      rawOutput?: unknown;
    },
  ) =>
    handleStreamEvent(
      {
        type: 'tool_call_update',
        data: { toolCallId: id, ...data },
      },
      ctx,
    );
  const interpretation = () => {
    const message = selectThreadMessages(
      useChatStore.getState(),
      ctx.threadId,
    ).find((message) => message.id === ctx.userMessageId);
    return message?.role === 'user' ? message.inkInterpretation : undefined;
  };
  beforeEach(() => {
    useChatStore.getState().addMessage(ctx.threadId, {
      id: ctx.userMessageId,
      role: 'user',
      content: '',
      inputKind: 'ink-intent',
      inkInterpretation: { state: 'pending' },
      selectedNodeIds: ['sketch-1'],
      selectedStrokeIds: [{ nodeId: 'sketch-1', strokeIds: ['stroke-1'] }],
    });
  });

  it('retains report output without confirming it before terminal status', () => {
    startReport('report-1', { text: '  Explain this arrow  ' });
    updateReport('report-1', {
      status: 'in_progress',
      rawOutput: {
        text: '  Explain this arrow  ',
        explanation: '  It connects the two notes.  ',
      },
    });
    expect(interpretation()).toEqual({ state: 'pending' });
    updateReport('report-1', { status: 'completed' });
    expect(interpretation()).toEqual({
      state: 'reported',
      text: 'Explain this arrow',
      explanation: 'It connects the two notes.',
    });
    updateReport('report-1', { rawOutput: '{}' });
    expect(selectThreadMessages(useChatStore.getState(), ctx.threadId)).toEqual(
      [expect.objectContaining({ content: '', selectedNodeIds: ['sketch-1'] })],
    );
  });

  it.each([
    ['failed', { status: 'failed' as const }],
    [
      'error envelope',
      {
        status: 'completed' as const,
        rawOutput: {
          tool: 'report_ink_intent',
          status: 'error',
          error: 'Rejected',
        },
      },
    ],
    [
      'malformed result',
      { status: 'completed' as const, rawOutput: 'not JSON' },
    ],
  ])(
    'does not confirm a %s report; a successful retry wins once',
    (_label, terminal) => {
      startReport('report-1', { text: 'Rejected summary' });
      updateReport('report-1', terminal);
      expect(interpretation()).toEqual({ state: 'failed' });
      startReport('report-2', {
        text: 'Accepted summary',
        explanation: 'Verified in context.',
      });
      updateReport('report-2', { status: 'completed' });
      startReport('report-3', { text: 'Later summary' });
      updateReport('report-3', { status: 'completed' });
      updateReport('report-2', { status: 'failed' });
      expect(interpretation()).toEqual({
        state: 'reported',
        text: 'Accepted summary',
        explanation: 'Verified in context.',
      });
    },
  );

  it('keeps reports in the captured user message and owner thread', () => {
    startReport('report-1', { text: 'First Ink request' });
    for (const threadId of ['thread-1', 'thread-2']) {
      useChatStore.getState().addMessage(threadId, {
        id: 'new-user',
        role: 'user',
        content: '',
        inputKind: 'ink-intent',
        inkInterpretation: { state: 'pending' },
      });
    }
    updateReport('report-1', { status: 'completed' });
    expect(interpretation()).toEqual({
      state: 'reported',
      text: 'First Ink request',
    });
    for (const threadId of ['thread-1', 'thread-2']) {
      expect(
        selectThreadMessages(useChatStore.getState(), threadId).find(
          (message) => message.id === 'new-user',
        ),
      ).toMatchObject({
        inkInterpretation: { state: 'pending' },
      });
    }
  });

  it('retains the original owner when missing args are followed by output after a newer user message', () => {
    const streamContext = {
      threadId: ctx.threadId,
      assistantId: ctx.assistantId,
    };
    handleStreamEvent(
      {
        type: 'tool_call',
        data: {
          toolCallId: 'delayed-report',
          title: 'report_ink_intent',
          internalToolName: 'report_ink_intent',
          status: 'pending',
        },
      },
      streamContext,
    );
    useChatStore.getState().addMessage(ctx.threadId, {
      id: 'newer-ink-user',
      role: 'user',
      content: '',
      inputKind: 'ink-intent',
      inkInterpretation: { state: 'pending' },
    });
    handleStreamEvent(
      {
        type: 'tool_call_update',
        data: {
          toolCallId: 'delayed-report',
          status: 'in_progress',
          rawOutput: { text: 'Original request interpretation' },
        },
      },
      streamContext,
    );
    expect(interpretation()).toEqual({ state: 'pending' });
    handleStreamEvent(
      {
        type: 'tool_call_update',
        data: { toolCallId: 'delayed-report', status: 'completed' },
      },
      streamContext,
    );
    expect(interpretation()).toEqual({
      state: 'reported',
      text: 'Original request interpretation',
    });
    expect(
      selectThreadMessages(useChatStore.getState(), ctx.threadId).at(-1),
    ).toMatchObject({
      id: 'newer-ink-user',
      inkInterpretation: { state: 'pending' },
    });
  });

  it('ignores a generic external tool with the same title', () => {
    startReport('external-report', { text: 'Not host owned' }, '');
    updateReport('external-report', { status: 'completed' });
    expect(interpretation()).toEqual({ state: 'pending' });
  });

  it('does not attach a text turn report to the preceding Ink request', () => {
    useChatStore.getState().addMessage(ctx.threadId, {
      id: 'text-user',
      role: 'user',
      content: 'Ordinary text',
    });
    const textCtx = { threadId: ctx.threadId, assistantId: 'text-assistant' };
    handleStreamEvent(
      {
        type: 'tool_call',
        data: {
          toolCallId: 'text-report',
          title: 'report_ink_intent',
          internalToolName: 'report_ink_intent',
          rawInput: { text: 'Wrong owner' },
        },
      },
      textCtx,
    );
    handleStreamEvent(
      {
        type: 'tool_call_update',
        data: { toolCallId: 'text-report', status: 'completed' },
      },
      textCtx,
    );
    handleStreamEvent({ type: 'done', data: { message: '' } }, textCtx);
    expect(interpretation()).toEqual({ state: 'pending' });
    expect(
      selectThreadMessages(useChatStore.getState(), ctx.threadId)[1],
    ).not.toHaveProperty('inkInterpretation');
  });

  it.each([
    [undefined, 'missing'],
    ['aborted', 'interrupted'],
    ['cancelled', 'interrupted'],
    ['error', 'failed'],
  ])('settles a no-report turn ending with %s as %s', (stopReason, state) => {
    handleStreamEvent(
      {
        type: 'done',
        data: { message: '', meta: { stopReason } },
      },
      ctx,
    );
    expect(interpretation()).toEqual({ state });
  });

  it.each([
    [
      { status: 'inferred', text: 'Old summary' },
      { state: 'reported', text: 'Old summary' },
    ],
    [{ status: 'clarify', text: 'Old question' }, { state: 'legacy' }],
    [{ status: 'unsupported', text: 'Old limitation' }, { state: 'legacy' }],
    [{ text: 'Invalid\nsummary' }, { state: 'failed' }],
  ])(
    'normalizes historical and malformed report payloads %j',
    (rawInput, expected) => {
      startReport('report-1', rawInput);
      updateReport('report-1', { status: 'completed' });
      handleStreamEvent({ type: 'done', data: { message: '' } }, ctx);
      expect(interpretation()).toEqual(expected);
    },
  );

  it.each([
    {
      text: '  Canonical summary  ',
      explanation: '  Confirmed context.  ',
      renamed: true,
    },
    {
      tool: 'report_ink_intent',
      status: 'success',
      data: {
        text: '  Canonical summary  ',
        explanation: '  Confirmed context.  ',
        renamed: true,
      },
    },
  ])('prefers canonical confirmed output over report input %j', (rawOutput) => {
    startReport('canonical-report', {
      text: 'Draft summary',
      explanation: 'Draft explanation.',
    });
    updateReport('canonical-report', { rawOutput });
    expect(interpretation()).toEqual({ state: 'pending' });
    updateReport('canonical-report', { status: 'completed' });
    expect(interpretation()).toEqual({
      state: 'reported',
      text: 'Canonical summary',
      explanation: 'Confirmed context.',
    });
  });

  it('retains the first successful legacy record through subsequent reports', () => {
    startReport('legacy-report', {
      status: 'clarify',
      text: 'An old question',
    });
    updateReport('legacy-report', { status: 'completed' });
    startReport('new-report', { text: 'New interpretation' });
    updateReport('new-report', { status: 'completed' });
    updateReport('new-report', { status: 'failed' });
    expect(interpretation()).toEqual({ state: 'legacy' });
  });

  it('allows a successful report to supersede a missing-report fallback', () => {
    handleStreamEvent({ type: 'done', data: { message: '' } }, ctx);
    expect(interpretation()).toEqual({ state: 'missing' });
    startReport('late-report', { text: 'Confirmed interpretation' });
    updateReport('late-report', { status: 'completed' });
    expect(interpretation()).toEqual({
      state: 'reported',
      text: 'Confirmed interpretation',
    });
  });

  it('initializes optimistic Ink as pending and settles no-report completion', async () => {
    mocks.stream.mockImplementationOnce(
      async (_a, _b, _c, callbacks: AgentStreamCallbacks) => {
        expect(
          selectThreadMessages(useChatStore.getState(), ctx.threadId).at(-1),
        ).toMatchObject({
          role: 'user',
          content: '',
          inkInterpretation: { state: 'pending' },
        });
        callbacks.onComplete();
      },
    );
    await dispatchAgentTurn(request('ink-intent'));
    expect(
      selectThreadMessages(useChatStore.getState(), ctx.threadId).at(-1),
    ).toMatchObject({ inkInterpretation: { state: 'missing' } });
  });

  it('settles optimistic Ink after stream rejection', async () => {
    mocks.stream.mockRejectedValueOnce(new Error('Offline'));
    await dispatchAgentTurn(request('ink-intent'));
    expect(
      selectThreadMessages(useChatStore.getState(), ctx.threadId)
        .filter((message) => message.role === 'user')
        .at(-1),
    ).toMatchObject({ inkInterpretation: { state: 'failed' } });
  });

  it('settles Ink only after stop is confirmed', async () => {
    const gate = deferred();
    mocks.stop.mockImplementationOnce(async () => {
      await gate.promise;
      return { stopped: true, acceptance: null };
    });
    stopAgentTurn(session);
    expect(interpretation()).toEqual({ state: 'pending' });
    gate.resolve();
    await vi.waitFor(() =>
      expect(interpretation()).toEqual({ state: 'interrupted' }),
    );
  });
});

describe('shared Agent turn input', () => {
  it('freezes Sigil targets through asynchronous saving and keeps them distinct from Canvas selection', async () => {
    const gate = deferred();
    mocks.save.mockReturnValueOnce(gate.promise);
    const prepared = request('ink-intent');
    prepared.inkResources = [
      {
        id: 'sigil',
        fingerprint: '0123456789abcdef',
        targetNodeId: 'paper',
        targetType: 'pdf',
        label: 'Original paper',
        sourceBounds: { x: 0, y: 0, width: 40, height: 40 },
        sources: [1, 2, 3, 4].map((i) => ({
          nodeId: 'sketch-1',
          strokeId: `stroke-${i}`,
        })),
      },
    ];
    const running = dispatchAgentTurn(prepared);
    prepared.inkResources[0].targetNodeId = 'replacement';
    gate.resolve();
    expect((await running).status).toBe('completed');
    expect(mocks.stream.mock.calls[0][4].inkResources[0].targetNodeId).toBe(
      'paper',
    );
    const message = selectThreadMessages(
      useChatStore.getState(),
      session.threadId,
    )[0];
    expect(message).toMatchObject({
      inkResources: [expect.objectContaining({ targetNodeId: 'paper' })],
      attachments: [
        expect.objectContaining({
          originNodeId: 'paper',
          label: 'Original paper',
        }),
      ],
    });
    if (message.role !== 'user') throw new Error('Expected user input');
    expect(message.selectedNodeIds).not.toContain('paper');
    const retry = prepareAgentTurnRetry(session, message, 'operate');
    expect(retry.inkResources?.[0].targetNodeId).toBe('paper');
    expect(retry.attachments).toEqual([]);
  });
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

  it('projects an Agent interpretation without rendering its tool call', () => {
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
            text: 'Expand the third comparison step',
            explanation: 'The arrow points to the third step.',
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
        inkInterpretation: {
          state: 'reported',
          text: 'Expand the third comparison step',
          explanation: 'The arrow points to the third step.',
        },
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
      expect.objectContaining({ inkInterpretation: { state: 'failed' } }),
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

  it.each(['ink-intent', 'selection-intent'] as const)(
    'sends %s without consuming same-thread drafts, uploads, excerpts or skills',
    async (inputKind) => {
      if (inputKind === 'selection-intent') {
        useGesturePreviewStore.setState({ sketchStrokeSelection: {} });
      }
      const attachment = {
        id: 'upload',
        type: 'text',
        content: 'private draft',
      } as unknown as ChatAttachment;
      useChatStore.getState().setDraft(session.threadId, 'Unsent draft');
      useChatStore
        .getState()
        .addPendingAttachment(session.threadId, attachment);
      useChatStore.getState().setSelectionAttachment(attachment);
      await dispatchAgentTurn(request(inputKind));
      expect(mocks.stream.mock.calls[0][0]).toBe('');
      expect(mocks.stream.mock.calls[0][4]).toMatchObject({
        inputKind,
        attachments: undefined,
        invokedSkills: undefined,
      });
      const state = useChatStore.getState();
      expect(state.threadsById[session.threadId].draft).toBe('Unsent draft');
      expect(state.threadsById[session.threadId].pendingAttachments).toEqual([
        attachment,
      ]);
      expect(state.selectionAttachment).toBe(attachment);
      expect(selectThreadMessages(state, session.threadId)[0]).toMatchObject({
        inputKind,
        inkInterpretation: { state: 'missing' },
      });
    },
  );

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

  it('sends and retries quote-only messages with the same structured snapshot', async () => {
    const quotedComments = [
      {
        quote: 'Original reply',
        contextBefore: 'Before ',
        contextAfter: ' after',
        comment: 'Explain this.',
        source: {
          kind: 'note' as const,
          canvasId: 'canvas-1',
          nodeId: 'source-note',
          snapshotRevision: 'snapshot',
        },
      },
      {
        quote: 'File passage',
        contextBefore: 'Before ',
        contextAfter: ' after',
        comment: 'Explain file.',
        source: {
          kind: 'file-reference' as const,
          canvasId: 'canvas-1',
          nodeId: 'file',
          agentletId: 'source-device',
          path: '/source.tex',
          contentVersion: 'a'.repeat(64),
          offsetUnit: 'utf-16' as const,
          from: 7,
          to: 19,
          loadedLength: 40,
          complete: false,
        },
      },
    ];
    const prepared = request();
    prepared.content = '';
    prepared.quotedComments = quotedComments;
    await dispatchAgentTurn(prepared);
    expect(mocks.stream.mock.calls[0][0]).toBe('');
    expect(mocks.stream.mock.calls[0][4].quotedComments).toEqual(
      quotedComments,
    );
    const message = selectThreadMessages(
      useChatStore.getState(),
      session.threadId,
    ).find((item) => item.role === 'user');
    expect(message).toMatchObject({ content: '', quotedComments });
    if (message?.role !== 'user') throw new Error('Missing user message');
    const retry = prepareAgentTurnRetry(session, message, 'operate');
    expect(retry.quotedComments).toEqual(quotedComments);
    await dispatchAgentTurn(retry);
    expect(mocks.stream.mock.calls[1][4].quotedComments).toEqual(
      quotedComments,
    );
  });

  it.each([true, false])(
    'clears quoted drafts before transport and restores only a rejected submission: %s',
    async (accepted) => {
      const store = useChatStore.getState();
      store.setDraft(session.threadId, 'General instructions');
      store.addQuotedComment(session.threadId, {
        quote: 'Original reply',
        contextBefore: '',
        contextAfter: '',
        comment: 'Explain this.',
        source: {
          kind: 'note',
          canvasId: 'canvas-1',
          nodeId: 'source-note',
          snapshotRevision: 'snapshot',
        },
      });
      mocks.stream.mockImplementationOnce(
        async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) => {
          expect(
            useChatStore.getState().threadsById[session.threadId].draft,
          ).toBe('');
          expect(
            useChatStore.getState().threadsById[session.threadId]
              .pendingQuotedComments,
          ).toHaveLength(0);
          if (accepted) {
            callbacks.onAccepted?.({
              threadId: session.threadId,
              turnStartSeq: 5,
            });
            callbacks.onComplete();
          } else {
            callbacks.onError(
              new ApiError(400, {}, 'Request rejected before acceptance'),
            );
          }
        },
      );
      let hook!: UseAgentStreamReturn;
      function Harness() {
        hook = useAgentStream(session);
        return null;
      }
      container = document.createElement('div');
      root = createRoot(container);
      await act(async () => root?.render(createElement(Harness)));
      await act(async () =>
        hook.startStream('General instructions', 'operate'),
      );
      const current = useChatStore.getState().threadsById[session.threadId];
      expect(current.draft).toBe(accepted ? '' : 'General instructions');
      expect(current.pendingQuotedComments).toHaveLength(accepted ? 0 : 1);
      expect(mocks.stream.mock.calls[0][4].quotedComments).toEqual([
        {
          quote: 'Original reply',
          contextBefore: '',
          contextAfter: '',
          comment: 'Explain this.',
          source: {
            kind: 'note',
            canvasId: 'canvas-1',
            nodeId: 'source-note',
            snapshotRevision: 'snapshot',
          },
        },
      ]);
    },
  );

  describe('composer selection exclusion', () => {
    it.each([true, false])(
      'keeps Note quote evidence independent of selected parent Frame context, excluded=%s',
      async (excluded) => {
        useCanvasStore.getState()._setStateNoAutosave({
          nodes: [
            {
              id: 'frame',
              type: 'frame',
              selected: true,
              position: { x: 0, y: 0 },
              data: {},
            },
            {
              id: 'source-note',
              type: 'note',
              parentId: 'frame',
              position: { x: 0, y: 0 },
              data: { content: 'Changed Note content' },
            },
          ],
        });
        const quote = {
          quote: 'Captured excerpt',
          contextBefore: 'before',
          contextAfter: 'after',
          comment: 'Explain',
          source: {
            kind: 'note' as const,
            canvasId: 'canvas-1',
            nodeId: 'source-note',
            snapshotRevision: 'captured',
          },
        };
        useChatStore.getState().addQuotedComment(session.threadId, quote);
        useChatStore
          .getState()
          .setExcludeCanvasSelection(session.threadId, excluded);
        let hook!: UseAgentStreamReturn;
        function Harness() {
          hook = useAgentStream(session);
          return null;
        }
        container = document.createElement('div');
        root = createRoot(container);
        await act(async () => root?.render(createElement(Harness)));
        await act(async () => hook.startStream('', 'operate'));
        const sent = mocks.stream.mock.calls[0][4];
        expect(sent.quotedComments).toEqual([quote]);
        if (excluded) {
          expect(sent.canvasContext).toEqual({ selectedNodes: [] });
        } else {
          expect(sent.canvasContext?.selectedNodes).toMatchObject([
            { id: 'frame', children: [{ id: 'source-note' }] },
          ]);
        }
        expect(useCanvasStore.getState().nodes[0].selected).toBe(true);
      },
    );

    it.each([
      { external: false, anchored: false },
      { external: true, anchored: false },
      { external: false, anchored: true },
      { external: true, anchored: true },
    ])(
      'sends empty selection, preserves explicit context and retries the original sources: %j',
      async ({ external, anchored }) => {
        vi.spyOn(
          useAcpThreadChangesStore.getState(),
          'load',
        ).mockResolvedValue();
        const owner = anchored ? questionSession : session;
        const binding = external
          ? {
              kind: 'external' as const,
              profileId: 'profile-1',
              alias: 'Agent',
            }
          : { kind: 'internal' as const };
        const canvas = useCanvasStore.getState();
        canvas._setStateNoAutosave({
          nodes: [
            {
              id: 'frame-1',
              type: 'frame',
              selected: true,
              position: { x: 0, y: 0 },
              data: {},
            },
            {
              id: 'image-1',
              type: 'image',
              parentId: 'frame-1',
              position: { x: 0, y: 0 },
              data: { src: 'artifact.png' },
            },
            {
              id: 'sketch-1',
              type: 'sketch',
              parentId: 'frame-1',
              position: { x: 0, y: 0 },
              data: {},
            },
            ...(anchored
              ? [
                  {
                    id: 'question-1',
                    type: 'question',
                    selected: true,
                    position: { x: 0, y: 0 },
                    data: {
                      threadId: 'thread-1',
                      status: 'idle',
                      agentBinding: binding,
                    },
                  },
                ]
              : []),
          ],
        });
        const nodes = useCanvasStore.getState().nodes;
        const strokes = useGesturePreviewStore.getState().sketchStrokeSelection;
        const attachment: ChatAttachment = {
          type: 'text',
          source: 'upload',
          content: 'Explicit upload',
        };
        const excerpt: ChatAttachment = {
          type: 'text',
          source: 'excerpt',
          content: 'Explicit excerpt',
        };
        const chat = useChatStore.getState();
        chat.setAgentBinding(session.threadId, binding);
        chat.addPendingAttachment(session.threadId, attachment);
        chat.setSelectionAttachment(excerpt);
        chat.setExcludeCanvasSelection(session.threadId, true);
        chat.setDraft(session.threadId, 'Hello');
        let hook!: UseAgentStreamReturn;
        function Harness() {
          hook = useAgentStream(owner);
          return null;
        }
        container = document.createElement('div');
        root = createRoot(container);
        await act(async () => root?.render(createElement(Harness)));
        await act(async () => hook.startStream('Hello', 'operate'));
        const sent = mocks.stream.mock.calls[0][4];
        expect(sent.canvasContext).toEqual({ selectedNodes: [] });
        expect(sent.attachments).toEqual([attachment, excerpt]);
        expect(sent.agentBinding).toEqual(binding);
        expect(sent.anchorNodeId).toBe(anchored ? 'question-1' : undefined);
        expect(
          selectThreadExcludeCanvasSelection(
            useChatStore.getState(),
            session.threadId,
          ),
        ).toBe(false);
        expect(useCanvasStore.getState().nodes).toBe(nodes);
        expect(useGesturePreviewStore.getState().sketchStrokeSelection).toBe(
          strokes,
        );
        const message = selectThreadMessages(
          useChatStore.getState(),
          session.threadId,
        ).find((item) => item.role === 'user');
        if (message?.role !== 'user') throw new Error('Missing user message');
        expect(message.selectedNodeIds).toBeUndefined();
        expect(message.selectedStrokeIds).toBeUndefined();
        await act(async () => hook.retryStream(message, 'operate'));
        expect(mocks.stream.mock.calls[1][4].canvasContext).toEqual({
          selectedNodes: [],
        });
        await act(async () => hook.startStream('Next message', 'operate'));
        expect(
          mocks.stream.mock.calls[2][4].canvasContext.selectedNodes,
        ).toEqual([
          {
            id: 'frame-1',
            type: 'frame',
            children: [
              { id: 'image-1', type: 'image', src: 'artifact.png' },
              { id: 'sketch-1', type: 'sketch', strokeIds: ['stroke-1'] },
            ],
          },
        ]);
      },
    );

    it('does not suppress explicit Ink intent or consume the composer exclusion', async () => {
      useChatStore.getState().setExcludeCanvasSelection(session.threadId, true);
      await dispatchAgentTurn(request('ink-intent'));
      expect(
        mocks.stream.mock.calls[0][4].canvasContext.selectedNodes,
      ).not.toEqual([]);
      expect(
        selectThreadExcludeCanvasSelection(
          useChatStore.getState(),
          session.threadId,
        ),
      ).toBe(true);
    });
  });

  describe('optimistic composer clearing', () => {
    let hook: UseAgentStreamReturn;
    const quote = {
      quote: 'Original reply',
      contextBefore: '',
      contextAfter: '',
      comment: 'Explain this.',
    };
    beforeEach(async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const store = useChatStore.getState();
      store.setDraft(session.threadId, 'Hello');
      store.addQuotedComment(session.threadId, quote);
      function Harness() {
        hook = useAgentStream(session);
        return null;
      }
      container = document.createElement('div');
      root = createRoot(container);
      await act(async () => root?.render(createElement(Harness)));
    });

    it('clears synchronously before saving and never clears a newer identical draft on acceptance', async () => {
      const saved = deferred();
      mocks.save.mockReturnValueOnce(saved.promise);
      mocks.stream.mockImplementationOnce(
        async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) => {
          const store = useChatStore.getState();
          store.setDraft(session.threadId, 'Hello');
          store.addQuotedComment(session.threadId, quote);
          callbacks.onAccepted?.({
            threadId: session.threadId,
            turnStartSeq: 5,
          });
          callbacks.onComplete();
        },
      );
      await act(async () => {
        const running = hook.startStream('Hello', 'operate');
        const current = useChatStore.getState().threadsById[session.threadId];
        expect(current.draft).toBe('');
        expect(current.pendingQuotedComments).toEqual([]);
        expect(mocks.stream).not.toHaveBeenCalled();
        saved.resolve();
        await running;
      });
      const current = useChatStore.getState().threadsById[session.threadId];
      expect(current.draft).toBe('Hello');
      expect(current.pendingQuotedComments).toHaveLength(1);
    });

    it('restores the exact snapshot when preparation rejects before transport', async () => {
      const snapshot = useChatStore.getState().threadsById[session.threadId];
      mocks.save.mockRejectedValueOnce(new Error('Save conflict'));
      await act(async () => hook.startStream('Hello', 'operate'));
      const current = useChatStore.getState().threadsById[session.threadId];
      expect(current.draft).toBe(snapshot.draft);
      expect(current.pendingQuotedComments).toEqual(
        snapshot.pendingQuotedComments,
      );
      expect(mocks.stream).not.toHaveBeenCalled();
    });

    it.each(['preflight', 'transport'])(
      'restores selection exclusion with the rejected draft: %s',
      async (phase) => {
        useChatStore
          .getState()
          .setExcludeCanvasSelection(session.threadId, true);
        if (phase === 'preflight') {
          mocks.save.mockRejectedValueOnce(new Error('Save conflict'));
        } else {
          mocks.stream.mockImplementationOnce(
            async (
              _content,
              _thread,
              _mode,
              callbacks: AgentStreamCallbacks,
            ) => {
              callbacks.onError(new ApiError(400, {}, 'Rejected'));
            },
          );
        }
        await act(async () => hook.startStream('Hello', 'operate'));
        expect(
          selectThreadExcludeCanvasSelection(
            useChatStore.getState(),
            session.threadId,
          ),
        ).toBe(true);
        expect(
          useChatStore.getState().threadsById[session.threadId].draft,
        ).toBe('Hello');
      },
    );

    it('does not reset exclusion staged for the next draft when the previous turn is accepted', async () => {
      useChatStore.getState().setExcludeCanvasSelection(session.threadId, true);
      mocks.stream.mockImplementationOnce(
        async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) => {
          const chat = useChatStore.getState();
          chat.setDraft(session.threadId, 'Next draft');
          chat.setExcludeCanvasSelection(session.threadId, true);
          callbacks.onAccepted?.({
            threadId: session.threadId,
            turnStartSeq: 5,
          });
          callbacks.onComplete();
        },
      );
      await act(async () => hook.startStream('Hello', 'operate'));
      expect(
        selectThreadExcludeCanvasSelection(
          useChatStore.getState(),
          session.threadId,
        ),
      ).toBe(true);
      expect(useChatStore.getState().threadsById[session.threadId].draft).toBe(
        'Next draft',
      );
    });

    it('clears a quote-only submission immediately', async () => {
      act(() => useChatStore.getState().setDraft(session.threadId, ''));
      await act(async () => {
        const running = hook.startStream('', 'operate');
        expect(
          useChatStore.getState().threadsById[session.threadId]
            .pendingQuotedComments,
        ).toEqual([]);
        await running;
      });
      expect(mocks.stream.mock.calls[0][0]).toBe('');
      expect(mocks.stream.mock.calls[0][4].quotedComments).toEqual([quote]);
    });

    it('restores a busy submission without changing the active stream claim', async () => {
      const claim = claimAgentStream('canvas-1', 'thread-1', 'post');
      if (!claim) throw new Error('Missing stream claim');
      try {
        await act(async () => hook.startStream('Hello', 'operate'));
        const current = useChatStore.getState().threadsById[session.threadId];
        expect(current.draft).toBe('Hello');
        expect(current.pendingQuotedComments).toHaveLength(1);
        expect(mocks.stream).not.toHaveBeenCalled();
        expect(hasAgentStreamClaim('canvas-1', 'thread-1')).toBe(true);
      } finally {
        claim.release();
      }
    });

    it('keeps a preflight-rejected snapshot retryable when the user has already started a new draft', async () => {
      mocks.save.mockImplementationOnce(async () => {
        useChatStore.getState().setDraft(session.threadId, 'Next draft');
        throw new Error('Save conflict');
      });
      await act(async () => hook.startStream('Hello', 'operate'));
      expect(useChatStore.getState().threadsById[session.threadId].draft).toBe(
        'Next draft',
      );
      const message = selectThreadMessages(
        useChatStore.getState(),
        session.threadId,
      ).find((item) => item.role === 'user');
      expect(message).toMatchObject({
        content: 'Hello',
        quotedComments: [quote],
        selectedNodeIds: ['note-1', 'sketch-1'],
      });
      if (message?.role !== 'user') throw new Error('Missing retry snapshot');
      const retry = prepareAgentTurnRetry(session, message, 'operate');
      expect(retry.content).toBe('Hello');
      expect(retry.quotedComments).toEqual([quote]);
      expect(
        selectThreadMessages(useChatStore.getState(), session.threadId).at(-1),
      ).toMatchObject({
        role: 'status',
        status: 'error',
        detail: 'Save conflict',
      });
      expect(mocks.stream).not.toHaveBeenCalled();
    });

    it.each(['text', 'quote'])(
      'keeps a newer %s draft instead of restoring a rejected submission',
      async (kind) => {
        mocks.stream.mockImplementationOnce(
          async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) => {
            const store = useChatStore.getState();
            if (kind === 'text') store.setDraft(session.threadId, 'Next draft');
            else
              store.addQuotedComment(session.threadId, {
                ...quote,
                comment: 'Next comment.',
              });
            callbacks.onError(new ApiError(400, {}, 'Rejected'));
          },
        );
        await act(async () => hook.startStream('Hello', 'operate'));
        const current = useChatStore.getState().threadsById[session.threadId];
        expect(current.draft).toBe(kind === 'text' ? 'Next draft' : '');
        expect(
          current.pendingQuotedComments.map((item) => item.comment),
        ).toEqual(kind === 'quote' ? ['Next comment.'] : []);
        expect(
          selectThreadMessages(useChatStore.getState(), session.threadId),
        ).toContainEqual(
          expect.objectContaining({
            role: 'user',
            content: 'Hello',
            quotedComments: [quote],
          }),
        );
      },
    );

    it('does not restore an accepted submission after a runtime failure', async () => {
      mocks.stream.mockImplementationOnce(
        async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) => {
          callbacks.onAccepted?.({
            threadId: session.threadId,
            turnStartSeq: 5,
          });
          callbacks.onError(new Error('Agent failed after acceptance'));
        },
      );
      await act(async () => hook.startStream('Hello', 'operate'));
      const current = useChatStore.getState().threadsById[session.threadId];
      expect(current.draft).toBe('');
      expect(current.pendingQuotedComments).toEqual([]);
    });

    it.each([true, false])(
      'waits for ambiguous acceptance to reconcile before deciding restoration: %s',
      async (accepted) => {
        mocks.stream.mockRejectedValueOnce(new Error('Connection lost'));
        await act(async () => hook.startStream('Hello', 'operate'));
        expect(
          useChatStore.getState().threadsById[session.threadId].draft,
        ).toBe('');
        expect(
          useChatStore.getState().threadsById[session.threadId]
            .pendingQuotedComments,
        ).toEqual([]);
        if (accepted) {
          act(() =>
            observeAgentTurnAcceptance('canvas-1', {
              threadId: session.threadId,
              turnStartSeq: 5,
            }),
          );
        } else {
          await act(async () => {
            stopAgentTurn(session);
            await vi.waitFor(() =>
              expect(
                useChatStore.getState().threadsById[session.threadId].draft,
              ).toBe('Hello'),
            );
          });
        }
        const current = useChatStore.getState().threadsById[session.threadId];
        expect(current.draft).toBe(accepted ? '' : 'Hello');
        expect(current.pendingQuotedComments).toHaveLength(accepted ? 0 : 1);
      },
    );
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
