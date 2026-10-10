// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agentRequestSchema,
  type RecentCanvasConversationResponse,
} from '@huabu/shared';

import { Button } from '@/components/Common/Button';
import { toast } from '@/components/Common/Toast';
import { createAreaSelectionSession } from '@/hooks/areaSelectionSession';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import { StrokeSelectionToolbar } from './StrokeSelectionToolbar';

import type { InkAgentDestinationPicker } from './InkAgentDestinationPicker';
import type {
  AgentTurnCallbacks,
  AgentTurnResult,
} from '@/hooks/agentTurnController';
import type { ComponentProps } from 'react';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  prepare: vi.fn(),
  dispatch: vi.fn(),
  createQuestion: vi.fn(),
  placement: vi.fn(),
  captureGrounding: vi.fn(),
  blobToDataUrl: vi.fn(),
  getViewport: vi.fn(),
  listProfiles: vi.fn(),
  recentConversation: vi.fn(),
  selecting: false,
  popoverAnchor: null as unknown,
}));

vi.mock('@/api/acp', () => ({ listAcpProfiles: mocks.listProfiles }));
vi.mock('@/api/canvas', async (original) => ({
  ...((await original()) as object),
  getRecentCanvasConversation: mocks.recentConversation,
}));
vi.mock('@/components/Common/Toast', () => ({ toast: vi.fn() }));
vi.mock('./InkAgentDestinationPicker', () => ({
  InkAgentDestinationPicker: (
    props: ComponentProps<typeof InkAgentDestinationPicker>,
  ) => (
    <div>
      <span data-picker-binding>{JSON.stringify(props.binding)}</span>
      <span data-picker-target>
        {props.selectedNodeId ?? (props.unresolved ? 'unresolved' : 'new')}
      </span>
      <span data-picker-reason>{props.unavailableReason}</span>
      {props.conversations.map((item) => (
        <Button
          key={item.nodeId}
          data-continue={item.nodeId}
          disabled={props.disabled || Boolean(item.disabledReason)}
          onClick={() => props.onContinueConversation(item.nodeId)}
        >
          {item.title}
        </Button>
      ))}
      <Button
        data-new-agent
        disabled={props.disabled}
        onClick={() =>
          props.onNewConversation({
            binding: { kind: 'internal' },
            mode: 'ask',
          })
        }
      >
        New internal Chat
      </Button>
    </div>
  ),
}));

vi.mock('@xyflow/react', async (original) => ({
  ...((await original()) as object),
  useReactFlow: () => ({ getViewport: mocks.getViewport }),
  useStore: (selector: (state: { userSelectionActive: boolean }) => unknown) =>
    selector({ userSelectionActive: mocks.selecting }),
}));
vi.mock('@/handler/canvasCommand/utils/screenshot', () => ({
  captureVisibleCanvasGrounding: mocks.captureGrounding,
  blobToDataUrl: mocks.blobToDataUrl,
}));

vi.mock('@/components/Common/CanvasFloatingPopover', async () => {
  const { createElement } = await import('react');
  return {
    CanvasFloatingPopover: ({
      anchor,
      open,
      className,
      children,
    }: {
      anchor: unknown;
      open: boolean;
      className?: string;
      children: React.ReactNode;
    }) => {
      mocks.popoverAnchor = anchor;
      return open ? createElement('div', { className }, children) : null;
    },
  };
});
vi.mock('@/components/Nodes/sketch/SketchControls', async () => {
  const { createElement } = await import('react');
  return {
    SketchControls: () => createElement('div', { 'data-sketch-controls': '' }),
  };
});
vi.mock('@/components/Nodes/sketch/sketchHitTest', () => ({
  getSketchStrokeSelectionBounds: (selection: Record<string, string[]>) =>
    Object.keys(selection).length > 0
      ? { x: 0, y: 0, width: 100, height: 50 }
      : null,
}));
vi.mock('@/hooks/useInputMode', () => ({ useIsNotMouse: () => false }));
vi.mock('@/hooks/agentTurnController', () => ({
  captureAgentTurnSources: mocks.capture,
  prepareAgentTurn: mocks.prepare,
  dispatchAgentTurn: mocks.dispatch,
}));
vi.mock('@/components/Nodes/question/questionCompose', () => ({
  createQuestionNode: mocks.createQuestion,
}));
vi.mock('@/components/Nodes/nodePlacement', () => ({
  computeAdjacentNodePlacement: mocks.placement,
}));

let root: Root;
let container: HTMLDivElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function sendButton() {
  const button = document.querySelector<HTMLButtonElement>(
    '.canvas-context-submit',
  );
  if (!button) throw new Error('Missing Send control');
  return button;
}

function deferredResult<T = AgentTurnResult>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function mountToolbar() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(StrokeSelectionToolbar));
  });
}

async function renderToolbar() {
  await mountToolbar();
  const button = document.body.querySelector<HTMLButtonElement>(
    'button[aria-label="Send ink request"]',
  );
  if (!button) throw new Error('Expected toolbar button');
  return button;
}

async function selectConversation(nodeId = 'question-1') {
  const option = document.querySelector<HTMLButtonElement>(
    `[data-continue="${nodeId}"]`,
  );
  if (!option) throw new Error('Expected conversation option');
  await act(async () => option.click());
}

async function cancelReplacementSelection() {
  const gesture = createAreaSelectionSession(true);
  mocks.selecting = true;
  await act(async () => {
    gesture.preview(null);
    root.render(createElement(StrokeSelectionToolbar));
  });
  mocks.selecting = false;
  await act(async () => {
    gesture.cancel();
    root.render(createElement(StrokeSelectionToolbar));
  });
}

function addQuestion(data: Record<string, unknown> = {}) {
  const state = useCanvasStore.getState();
  state._setStateNoAutosave({
    nodes: [
      ...state.nodes,
      {
        id: 'question-1',
        type: 'question',
        selected: false,
        position: { x: 200, y: 0 },
        data: {
          threadId: 'thread-existing',
          label: 'Existing conversation',
          agentBinding: { kind: 'internal' },
          agentMode: 'ask',
          ...data,
        },
      },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selecting = false;
  mocks.recentConversation
    .mockReset()
    .mockResolvedValue({ conversation: null });
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: 'canvas-1',
    nodes: [
      {
        id: 'sketch-1',
        type: 'sketch',
        position: { x: 0, y: 0 },
        data: {},
      },
    ],
    edges: [],
    pendingForkThreadIds: {},
  });
  useChatStore.setState({
    threadsById: {},
    bindingByThread: {},
    settingsByThread: {},
    lastActionByThread: {},
  });
  const profiles = [
    {
      id: 'default-profile',
      alias: 'Default Copilot',
      agentletId: 'machine-1',
      workingDirPath: '/tmp',
      launch: { kind: 'acp-command' as const, command: 'copilot --acp' },
    },
  ];
  useAcpProfilesStore.setState({
    profiles,
    selectableProfileIds: ['default-profile'],
    agentDefaults: { profileId: 'default-profile', functionalModel: '' },
    recentConversationProfileId: 'default-profile',
    loaded: true,
    error: null,
    defaultsError: null,
  });
  mocks.listProfiles.mockReset().mockResolvedValue({
    profiles,
    selectableProfileIds: ['default-profile'],
    agentlet: null,
    agentDefaults: null,
  });
  useGesturePreviewStore.setState({
    sketchStrokeSelection: { 'sketch-1': ['stroke-1'] },
    sketchSelectionPolygon: [
      { x: 20, y: 30 },
      { x: 80, y: 30 },
      { x: 80, y: 70 },
      { x: 20, y: 70 },
    ],
    sketchSelectionSession: {},
    sketchStrokeMovePreview: null,
    inkSubmissionPreparing: false,
  });
  mocks.popoverAnchor = null;
  mocks.capture.mockReturnValue({
    canvasId: 'canvas-1',
    canvasContext: {
      selectedNodes: [
        { id: 'sketch-1', type: 'sketch', strokeIds: ['stroke-1'] },
      ],
    },
  });
  mocks.prepare.mockImplementation((input) => ({
    ...input,
    agentBinding: { kind: 'internal' },
    settings: { modelId: null, reasoningEffort: null },
  }));
  mocks.createQuestion.mockReturnValue({
    nodeId: 'question-1',
    threadId: 'thread-1',
    conversationView: {
      presentationAnchor: { canvasId: 'canvas-1', nodeId: 'question-1' },
      conversationOwner: {
        canvasId: 'canvas-1',
        nodeId: 'question-1',
        threadId: 'thread-1',
      },
    },
  });
  mocks.placement.mockReturnValue({ x: 10, y: 100 });
  mocks.getViewport.mockReturnValue({ x: 0, y: 0, zoom: 1 });
  mocks.captureGrounding.mockResolvedValue({
    blob: new Blob(['png'], { type: 'image/png' }),
    crop: { x: 0, y: 0, width: 220, height: 100 },
    devicePixelRatio: 2,
    viewport: { width: 1200, height: 800 },
  });
  mocks.blobToDataUrl.mockResolvedValue('data:image/png;base64,cG5n');
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('StrokeSelectionToolbar Ink submission', () => {
  it('previews cached recency but waits for the current server target before sending', async () => {
    addQuestion();
    const state = useCanvasStore.getState();
    state._setStateNoAutosave({
      nodes: [
        ...state.nodes,
        {
          id: 'question-2',
          type: 'question',
          position: { x: 400, y: 0 },
          data: {
            threadId: 'thread-second',
            agentBinding: { kind: 'internal' },
          },
        },
      ],
    });
    useGesturePreviewStore.setState({
      sketchStrokeSelection: {},
      sketchSelectionPolygon: null,
      sketchSelectionSession: null,
    });
    mocks.recentConversation.mockResolvedValueOnce({
      conversation: { nodeId: 'question-1', threadId: 'thread-existing' },
    });
    await mountToolbar();
    expect(mocks.recentConversation).toHaveBeenCalledTimes(1);

    const refresh = deferredResult<RecentCanvasConversationResponse>();
    mocks.recentConversation.mockReturnValueOnce(refresh.promise);
    await act(async () => {
      useGesturePreviewStore.setState({
        sketchStrokeSelection: { 'sketch-1': ['stroke-1'] },
        sketchSelectionPolygon: [
          { x: 20, y: 30 },
          { x: 80, y: 30 },
          { x: 80, y: 70 },
          { x: 20, y: 70 },
        ],
        sketchSelectionSession: {},
      });
      root.render(createElement(StrokeSelectionToolbar));
    });

    expect(mocks.recentConversation).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
      'question-1',
    );
    expect(document.body.textContent).not.toContain('Loading conversation');
    expect(sendButton().disabled).toBe(true);
    await act(async () => sendButton().click());
    expect(mocks.dispatch).not.toHaveBeenCalled();

    await act(async () =>
      refresh.resolve({
        conversation: { nodeId: 'question-2', threadId: 'thread-second' },
      }),
    );
    expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
      'question-2',
    );
    expect(sendButton().disabled).toBe(false);
    mocks.dispatch.mockResolvedValueOnce({ status: 'completed' });
    await act(async () => sendButton().click());
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ threadId: 'thread-second' }),
      }),
    );
    expect(mocks.dispatch).toHaveBeenCalledOnce();
  });

  it('waits for Lasso completion and refreshes when a new gesture replaces a retained selection', async () => {
    addQuestion();
    mocks.selecting = true;
    await mountToolbar();
    expect(mocks.recentConversation).not.toHaveBeenCalled();
    mocks.selecting = false;
    await act(async () => root.render(createElement(StrokeSelectionToolbar)));
    expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
      'question-1',
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-new-agent]')?.click(),
    );
    mocks.selecting = true;
    await act(async () => root.render(createElement(StrokeSelectionToolbar)));
    mocks.selecting = false;
    await act(async () => {
      const preview = useGesturePreviewStore.getState();
      preview.commitSketchSelection(preview.sketchSelectionPolygon);
      root.render(createElement(StrokeSelectionToolbar));
    });
    expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
      'question-1',
    );
    expect(mocks.recentConversation).toHaveBeenCalledTimes(2);
  });

  it.each(['continue', 'new'] as const)(
    'restores a manual %s destination when a replacement Lasso is cancelled',
    async (kind) => {
      addQuestion();
      const state = useCanvasStore.getState();
      state._setStateNoAutosave({
        nodes: [
          ...state.nodes,
          {
            id: 'question-2',
            type: 'question',
            position: { x: 400, y: 0 },
            data: {
              threadId: 'thread-second',
              agentBinding: { kind: 'internal' },
            },
          },
        ],
      });
      mocks.recentConversation.mockResolvedValue({
        conversation: { nodeId: 'question-1', threadId: 'thread-existing' },
      });
      await mountToolbar();
      if (kind === 'continue') await selectConversation('question-2');
      else {
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>('[data-new-agent]')
            ?.click(),
        );
      }
      const before = useGesturePreviewStore.getState();
      await cancelReplacementSelection();
      expect(useGesturePreviewStore.getState().sketchStrokeSelection).toBe(
        before.sketchStrokeSelection,
      );
      expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
        kind === 'continue' ? 'question-2' : 'new',
      );
      expect(sendButton().disabled).toBe(false);
      expect(mocks.recentConversation).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves the destination while moving the retained polygon', async () => {
    addQuestion();
    await mountToolbar();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-new-agent]')?.click(),
    );
    await act(async () => {
      const preview = useGesturePreviewStore.getState();
      if (!preview.sketchSelectionPolygon)
        throw new Error('Expected retained Lasso polygon');
      preview.setSketchSelectionPolygon(
        preview.sketchSelectionPolygon.map(({ x, y }) => ({
          x: x + 10,
          y: y + 10,
        })),
      );
    });
    expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
      'new',
    );
    expect(mocks.recentConversation).toHaveBeenCalledTimes(1);
  });

  it('resumes an interrupted default read after cancellation without accepting its stale response', async () => {
    let resolve!: (value: {
      conversation: { nodeId: string; threadId: string };
    }) => void;
    const pending = new Promise<{
      conversation: { nodeId: string; threadId: string };
    }>((done) => {
      resolve = done;
    });
    mocks.recentConversation.mockReturnValueOnce(pending);
    await mountToolbar();
    await cancelReplacementSelection();
    expect(mocks.recentConversation).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
      'new',
    );
    await act(async () => {
      resolve({ conversation: { nodeId: 'old', threadId: 'old-thread' } });
      await pending;
    });
    expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
      'new',
    );
  });

  it('keeps a rejected new-node reservation when a replacement Lasso is cancelled', async () => {
    mocks.dispatch.mockResolvedValue({ status: 'rejected' });
    await mountToolbar();
    await act(async () => sendButton().click());
    await cancelReplacementSelection();
    await act(async () => sendButton().click());
    expect(mocks.createQuestion).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(mocks.recentConversation).toHaveBeenCalledTimes(1);
  });

  it('discards a rejected reservation for a committed replacement with identical strokes', async () => {
    mocks.dispatch.mockResolvedValue({ status: 'rejected' });
    await mountToolbar();
    await act(async () => sendButton().click());
    await act(async () => {
      const preview = useGesturePreviewStore.getState();
      preview.commitSketchSelection(preview.sketchSelectionPolygon);
    });
    await act(async () => sendButton().click());
    expect(mocks.createQuestion).toHaveBeenCalledTimes(2);
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(mocks.recentConversation).toHaveBeenCalledTimes(2);
  });

  it('automatically continues the shared recent thread without creating or copying a conversation', async () => {
    addQuestion();
    mocks.recentConversation.mockResolvedValue({
      conversation: { nodeId: 'question-1', threadId: 'thread-existing' },
    });
    mocks.dispatch.mockResolvedValue({ status: 'rejected' });
    await mountToolbar();
    expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
      'question-1',
    );
    await act(async () => sendButton().click());
    expect(mocks.createQuestion).not.toHaveBeenCalled();
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          canvasId: 'canvas-1',
          threadId: 'thread-existing',
        }),
      }),
    );
  });

  it('preselects a singleton when no recent conversation exists', async () => {
    addQuestion();
    await mountToolbar();
    expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
      'question-1',
    );
    expect(sendButton().disabled).toBe(false);
  });

  it.each([
    { nodeId: 'missing-node', threadId: 'deleted-thread' },
    { nodeId: 'question-1', threadId: 'old-thread' },
  ])(
    'does not replace an invalid remembered association $threadId',
    async (conversation) => {
      addQuestion();
      mocks.recentConversation.mockResolvedValue({ conversation });
      await mountToolbar();
      expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
        conversation.nodeId,
      );
      expect(sendButton().disabled).toBe(true);
      expect(mocks.createQuestion).not.toHaveBeenCalled();
      await selectConversation();
      expect(sendButton().disabled).toBe(false);
    },
  );

  it('retains a busy remembered destination instead of falling back to New', async () => {
    addQuestion({ status: 'running' });
    mocks.recentConversation.mockResolvedValue({
      conversation: { nodeId: 'question-1', threadId: 'thread-existing' },
    });
    await mountToolbar();
    expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
      'question-1',
    );
    expect(sendButton().disabled).toBe(true);
    await act(async () => {
      const state = useCanvasStore.getState();
      state._setStateNoAutosave({
        nodes: state.nodes.map((node) =>
          node.id === 'question-1'
            ? { ...node, data: { ...node.data, status: 'idle' } }
            : node,
        ),
      });
    });
    expect(sendButton().disabled).toBe(false);
  });

  it('blocks unresolved loading and ignores a late response after an explicit choice', async () => {
    addQuestion();
    const state = useCanvasStore.getState();
    state._setStateNoAutosave({
      nodes: [
        ...state.nodes,
        {
          id: 'question-2',
          type: 'question',
          position: { x: 400, y: 0 },
          data: {
            threadId: 'thread-second',
            agentBinding: { kind: 'internal' },
          },
        },
      ],
    });
    let resolve!: (value: { conversation: null }) => void;
    const pending = new Promise<{ conversation: null }>((done) => {
      resolve = done;
    });
    mocks.recentConversation.mockReturnValue(pending);
    await mountToolbar();
    expect(sendButton().disabled).toBe(true);
    expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
      'unresolved',
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-new-agent]')?.click(),
    );
    expect(sendButton().disabled).toBe(false);
    await act(async () => {
      resolve({ conversation: null });
      await pending;
    });
    expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
      'new',
    );
  });

  it('shows the default Agent immediately while an empty Space refreshes', async () => {
    mocks.recentConversation.mockReturnValue(new Promise(() => {}));

    await mountToolbar();

    expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
      'new',
    );
    expect(document.body.textContent).not.toContain('Loading conversation');
    expect(sendButton().disabled).toBe(true);
  });

  it('keeps a manually confirmed destination stable when recency returns during grounding', async () => {
    addQuestion();
    const state = useCanvasStore.getState();
    state._setStateNoAutosave({
      nodes: [
        ...state.nodes,
        {
          id: 'note-1',
          type: 'note',
          selected: true,
          position: { x: 120, y: 0 },
          data: {},
        },
      ],
    });
    const recent = deferredResult<RecentCanvasConversationResponse>();
    mocks.recentConversation.mockReturnValueOnce(recent.promise);
    mocks.captureGrounding.mockImplementationOnce(async () => {
      recent.resolve({
        conversation: {
          nodeId: 'deleted-question',
          threadId: 'deleted-thread',
        },
      });
      await recent.promise;
      return {
        blob: new Blob(['png'], { type: 'image/png' }),
        crop: { x: 0, y: 0, width: 220, height: 100 },
        devicePixelRatio: 2,
        viewport: { width: 1200, height: 800 },
      };
    });
    mocks.dispatch.mockResolvedValueOnce({ status: 'completed' });
    await mountToolbar();
    expect(sendButton().disabled).toBe(true);
    await selectConversation();
    expect(sendButton().disabled).toBe(false);
    await act(async () => sendButton().click());
    expect(mocks.captureGrounding).toHaveBeenCalledOnce();
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ threadId: 'thread-existing' }),
      }),
    );
    expect(toast).not.toHaveBeenCalled();
  });

  it('shows read failures without silently creating a conversation', async () => {
    mocks.recentConversation.mockRejectedValue(new Error('Offline'));
    await mountToolbar();
    expect(sendButton().disabled).toBe(true);
    expect(
      document.querySelector('[data-picker-reason]')?.textContent,
    ).toContain('Offline');
    expect(mocks.createQuestion).not.toHaveBeenCalled();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-new-agent]')?.click(),
    );
    expect(sendButton().disabled).toBe(false);
  });

  it('discards abandoned choices and reloads the server target on the next Lasso', async () => {
    addQuestion();
    mocks.recentConversation.mockResolvedValue({
      conversation: { nodeId: 'question-1', threadId: 'thread-existing' },
    });
    await mountToolbar();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-new-agent]')?.click(),
    );
    await act(async () =>
      useGesturePreviewStore.getState().clearSketchStrokeSelection(),
    );
    await act(async () =>
      useGesturePreviewStore.setState({
        sketchStrokeSelection: { 'sketch-1': ['stroke-2'] },
      }),
    );
    expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
      'question-1',
    );
    expect(mocks.recentConversation).toHaveBeenCalledTimes(2);
  });

  it('ignores the previous Space response after switching Space', async () => {
    let resolve!: (value: {
      conversation: { nodeId: string; threadId: string };
    }) => void;
    const pending = new Promise<{
      conversation: { nodeId: string; threadId: string };
    }>((done) => {
      resolve = done;
    });
    mocks.recentConversation
      .mockReturnValueOnce(pending)
      .mockResolvedValue({ conversation: null });
    await mountToolbar();
    await act(async () =>
      useCanvasStore.getState()._setStateNoAutosave({ canvasId: 'canvas-2' }),
    );
    expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
      'new',
    );
    await act(async () => {
      resolve({
        conversation: { nodeId: 'old-question', threadId: 'old-thread' },
      });
      await pending;
    });
    expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
      'new',
    );
    expect(mocks.recentConversation.mock.calls[1][0]).toBe('canvas-2');
  });

  it('keeps pending forks visible but unavailable for continuation', async () => {
    addQuestion();
    useCanvasStore.getState()._setStateNoAutosave({
      pendingForkThreadIds: { 'thread-existing': true },
    });
    await mountToolbar();
    expect(
      document.querySelector<HTMLButtonElement>('[data-continue]')?.disabled,
    ).toBe(true);
    expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
      'unresolved',
    );
    expect(
      document.querySelector<HTMLButtonElement>('.canvas-context-submit')
        ?.disabled,
    ).toBe(true);
  });

  it('continues an unselected conversation and ignores selected busy Agent Nodes', async () => {
    addQuestion();
    mocks.dispatch.mockResolvedValue({ status: 'rejected' });
    const submit = await renderToolbar();
    await selectConversation();
    await act(async () => {
      const state = useCanvasStore.getState();
      state._setStateNoAutosave({
        nodes: [
          ...state.nodes,
          {
            id: 'busy',
            type: 'question',
            selected: true,
            position: { x: 400, y: 0 },
            data: { threadId: 'thread-busy', status: 'running' },
          },
        ],
      });
    });
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    expect(mocks.createQuestion).not.toHaveBeenCalled();
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ threadId: 'thread-existing' }),
        sources: expect.objectContaining({
          canvasContext: {
            selectedNodes: [
              { id: 'sketch-1', type: 'sketch', strokeIds: ['stroke-1'] },
            ],
          },
        }),
      }),
    );
  });

  it('uses ChatPanel recency and explicit mode when choosing a new Agent', async () => {
    mocks.dispatch.mockResolvedValue({ status: 'rejected' });
    const submit = await renderToolbar();
    const choose =
      document.querySelector<HTMLButtonElement>('[data-new-agent]');
    await act(async () => choose?.click());
    expect(useAcpProfilesStore.getState().recentConversationProfileId).toBe(
      'huabu',
    );
    await act(async () => submit.click());
    expect(mocks.createQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: { kind: 'internal' },
        mode: 'ask',
      }),
    );
  });

  it('disables a busy continuation and restores it without changing the selected destination', async () => {
    addQuestion();
    await mountToolbar();
    await selectConversation();
    await act(async () =>
      useChatStore.getState().setThreadLoading('thread-existing', true),
    );
    const send = document.querySelector<HTMLButtonElement>(
      '.canvas-context-submit',
    );
    expect(send?.disabled).toBe(true);
    expect(
      document.querySelector<HTMLButtonElement>('[data-continue]')?.disabled,
    ).toBe(true);
    await act(async () =>
      useChatStore.getState().setThreadLoading('thread-existing', false),
    );
    expect(send?.disabled).toBe(false);
    expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
      'question-1',
    );
  });

  it('keeps a deleted destination selected but unavailable until explicit reselection', async () => {
    addQuestion();
    await mountToolbar();
    await selectConversation();
    await act(async () => {
      const state = useCanvasStore.getState();
      state._setStateNoAutosave({
        nodes: state.nodes.filter((node) => node.id !== 'question-1'),
      });
    });
    expect(
      document.querySelector<HTMLButtonElement>('.canvas-context-submit')
        ?.disabled,
    ).toBe(true);
    expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
      'question-1',
    );
    expect(mocks.createQuestion).not.toHaveBeenCalled();
  });

  it('excludes Agent Nodes nested in selected Frames from source and grounding trees', async () => {
    const state = useCanvasStore.getState();
    state._setStateNoAutosave({
      nodes: [
        {
          id: 'frame',
          type: 'frame',
          selected: true,
          position: { x: 0, y: 0 },
          data: {},
        },
        { ...state.nodes[0], parentId: 'frame' },
        {
          id: 'question',
          type: 'question',
          parentId: 'frame',
          position: { x: 0, y: 0 },
          data: { threadId: 'ignored', content: 'private reference' },
        },
      ],
    });
    mocks.dispatch.mockResolvedValue({ status: 'rejected' });
    const send = await renderToolbar();
    await act(async () => send.click());
    const prepared = mocks.prepare.mock.calls[0][0];
    expect(prepared.sources.canvasContext.selectedNodes).toEqual([
      {
        id: 'frame',
        type: 'frame',
        children: [{ id: 'sketch-1', type: 'sketch', strokeIds: ['stroke-1'] }],
      },
    ]);
    expect(prepared.groundingVisual.selectedNodeIds).toEqual(['frame']);
    expect(JSON.stringify(prepared.sources)).not.toContain('private reference');
  });

  it('rechecks the shared default after dismissing the Lasso without adding a Profile preference', async () => {
    addQuestion();
    await mountToolbar();
    await selectConversation();
    await act(async () =>
      useGesturePreviewStore.getState().clearSketchStrokeSelection(),
    );
    await act(async () =>
      useGesturePreviewStore.setState({
        sketchStrokeSelection: { 'sketch-1': ['stroke-2'] },
      }),
    );
    expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
      'question-1',
    );
    expect(mocks.recentConversation).toHaveBeenCalledTimes(2);
    expect(useAcpProfilesStore.getState().recentConversationProfileId).toBe(
      'default-profile',
    );
  });

  it('locks destination changes during preparation and revalidates continuation before dispatch', async () => {
    addQuestion();
    let callbacks: AgentTurnCallbacks | undefined;
    const pending = deferredResult();
    mocks.dispatch.mockImplementation((_input, received) => {
      callbacks = received;
      return pending.promise;
    });
    const submit = await renderToolbar();
    await selectConversation();
    await act(async () => submit.click());
    expect(
      document.querySelector<HTMLButtonElement>('[data-new-agent]')?.disabled,
    ).toBe(true);
    expect(callbacks?.canDispatch?.()).toBe(true);
    await act(async () =>
      useChatStore.getState().setThreadLoading('thread-existing', true),
    );
    expect(callbacks?.canDispatch?.()).toBe(false);
    pending.resolve({ status: 'busy' });
    await act(async () => pending.promise);
  });

  it('rejects a continuation whose thread association changes during preparation', async () => {
    addQuestion();
    let callbacks: AgentTurnCallbacks | undefined;
    const pending = deferredResult();
    mocks.dispatch.mockImplementation((_input, received) => {
      callbacks = received;
      return pending.promise;
    });
    const submit = await renderToolbar();
    await selectConversation();
    await act(async () => submit.click());
    await act(async () => {
      const state = useCanvasStore.getState();
      state._setStateNoAutosave({
        nodes: state.nodes.map((node) =>
          node.id === 'question-1'
            ? { ...node, data: { ...node.data, threadId: 'replaced-thread' } }
            : node,
        ),
      });
    });
    expect(callbacks?.canDispatch?.()).toBe(false);
    expect(mocks.prepare.mock.calls[0][0].session.threadId).toBe(
      'thread-existing',
    );
    pending.resolve({ status: 'rejected' });
    await act(async () => pending.promise);
  });

  it('reuses a rejected new-node reservation after switching away and back to the same Agent', async () => {
    addQuestion();
    mocks.dispatch.mockResolvedValue({ status: 'rejected' });
    await mountToolbar();
    const newChoice =
      document.querySelector<HTMLButtonElement>('[data-new-agent]');
    await act(async () => newChoice?.click());
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('.canvas-context-submit')
        ?.click(),
    );
    await selectConversation();
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('.canvas-context-submit')
        ?.click(),
    );
    await act(async () => newChoice?.click());
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('.canvas-context-submit')
        ?.click(),
    );
    expect(mocks.createQuestion).toHaveBeenCalledOnce();
    expect(mocks.dispatch).toHaveBeenCalledTimes(3);
  });

  it('loads and snapshots the browser fallback for a new Ink Question', async () => {
    mocks.dispatch.mockResolvedValueOnce({ status: 'completed' });
    const button = await renderToolbar();
    await act(async () => button.click());
    expect(mocks.listProfiles).toHaveBeenCalledOnce();
    expect(mocks.createQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: {
          kind: 'external',
          profileId: 'default-profile',
          alias: 'Default Copilot',
        },
        mode: 'ask',
        pendingInkIntentLabel: true,
      }),
    );
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'ask' }),
    );
  });

  it('keeps the Ink selection and creates nothing when Profiles are unavailable', async () => {
    mocks.listProfiles.mockRejectedValueOnce(new Error('Server unavailable'));
    const button = await renderToolbar();
    await act(async () => button.click());
    expect(mocks.createQuestion).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.any(String), { tone: 'danger' });
    expect(useGesturePreviewStore.getState().sketchStrokeSelection).toEqual({
      'sketch-1': ['stroke-1'],
    });

    expect(useGesturePreviewStore.getState().inkSubmissionPreparing).toBe(
      false,
    );
  });

  it('restores operate mode for new Ink Questions with a recent Built-In selection', async () => {
    useAcpProfilesStore.setState({ recentConversationProfileId: 'huabu' });
    const button = await renderToolbar();
    await act(async () => button.click());
    expect(mocks.createQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: { kind: 'internal' },
        mode: 'operate',
      }),
    );
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'operate' }),
    );
  });

  it('requires an external Profile instead of falling back to the internal Agent', async () => {
    mocks.listProfiles.mockResolvedValueOnce({
      profiles: [],
      selectableProfileIds: [],
      agentlet: null,
      agentDefaults: null,
    });
    const button = await renderToolbar();
    await act(async () => button.click());
    expect(mocks.createQuestion).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.any(String), { tone: 'danger' });
  });

  it.each(['selection', 'canvas'] as const)(
    'does not create an Ink Question after %s changes during default loading',
    async (change) => {
      let resolveDefaults!: (value: unknown) => void;
      mocks.listProfiles.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveDefaults = resolve;
          }),
      );
      const button = await renderToolbar();
      await act(async () => button.click());
      expect(mocks.createQuestion).not.toHaveBeenCalled();
      await act(async () => {
        if (change === 'canvas') {
          useCanvasStore
            .getState()
            ._setStateNoAutosave({ canvasId: 'canvas-2' });
        } else {
          useGesturePreviewStore.setState({
            sketchStrokeSelection: { 'sketch-1': ['stroke-2'] },
          });
        }
        resolveDefaults({
          profiles: useAcpProfilesStore.getState().profiles,
          selectableProfileIds: ['default-profile'],
          agentlet: null,
          agentDefaults: null,
        });
      });
      expect(mocks.createQuestion).not.toHaveBeenCalled();
      expect(mocks.dispatch).not.toHaveBeenCalled();
    },
  );

  it('keeps submit visible without a source count for a mixed selection', async () => {
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [
        {
          id: 'sketch-1',
          type: 'sketch',
          selected: true,
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: 'note-1',
          type: 'note',
          selected: true,
          position: { x: 120, y: 0 },
          measured: { width: 3000, height: 2000 },
          data: {},
        },
      ],
    });

    await mountToolbar();

    expect(document.body.textContent).not.toContain('2 sources');
    expect(
      document.body.querySelector('[data-picker-binding]')?.textContent,
    ).toContain('Default Copilot');
    const submit = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Send ink request"]',
    );
    expect(submit).not.toBeNull();
    expect(
      document.body.querySelector('.ink-agent-group')?.contains(submit),
    ).toBe(true);
    expect(document.body.querySelector('.lucide-shapes')).not.toBeNull();
    expect(document.body.querySelector('.lucide-pencil')).toBeNull();
    expect(document.body.querySelector('[data-sketch-controls]')).toBeNull();
    expect(submit?.disabled).toBe(false);
    expect(submit?.className).toContain('bg-inverse');
    expect(submit?.className).toContain('rounded-md');
    expect(mocks.popoverAnchor).toEqual({
      x: 20,
      y: 30,
      width: 60,
      height: 40,
    });
  });

  it('keeps Delete in an always-visible overflow menu', async () => {
    const state = useCanvasStore.getState();
    state._setStateNoAutosave({
      nodes: state.nodes.map((node) =>
        node.id === 'sketch-1'
          ? {
              ...node,
              data: {
                strokes: [
                  {
                    id: 'stroke-1',
                    points: [[0, 0]],
                    color: 'teal',
                    size: 4,
                    createdAt: 1,
                  },
                ],
              },
            }
          : node,
      ),
    });
    await mountToolbar();
    const more = document.body
      .querySelector('.lucide-ellipsis')
      ?.closest<HTMLButtonElement>('button');
    expect(more).not.toBeNull();
    const editGroup = document.body.querySelector('.ink-edit-group');
    const agentGroup = document.body.querySelector('.ink-agent-group');
    const toolbarContainer = document.body.querySelector(
      '.ink-context-toolbar',
    );
    expect(editGroup?.contains(more ?? null)).toBe(true);
    expect(editGroup?.className).toContain('bg-surface');
    expect(agentGroup?.className).toContain('bg-surface');
    expect(editGroup?.parentElement).toBe(toolbarContainer);
    expect(agentGroup?.parentElement).toBe(toolbarContainer);
    expect(editGroup?.querySelector('.lucide-pencil')).not.toBeNull();
    expect(editGroup?.querySelector('.lucide-shapes')).toBeNull();
    expect(editGroup?.querySelectorAll('.bg-edge-default')).toHaveLength(2);
    expect(agentGroup?.querySelector('.bg-edge-default')).toBeNull();
    expect(
      [...(toolbarContainer?.children ?? [])].some((child) =>
        child.classList.contains('bg-edge-default'),
      ),
    ).toBe(false);
    expect(
      Boolean(
        (editGroup && agentGroup
          ? editGroup.compareDocumentPosition(agentGroup)
          : 0) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(document.body.querySelector('.lucide-trash-2')).toBeNull();

    await act(async () => more?.click());

    const deleteItem = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((item) => item.textContent === 'Delete');
    expect(deleteItem?.className).toContain('text-danger');
    await act(async () => deleteItem?.click());
    expect(useGesturePreviewStore.getState().sketchStrokeSelection).toEqual({});
  });

  it('keeps only the identity divider when a mixed selection has no style controls', async () => {
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [
        ...useCanvasStore.getState().nodes,
        {
          id: 'note-1',
          type: 'note',
          selected: true,
          position: { x: 120, y: 0 },
          data: {},
        },
      ],
    });

    await mountToolbar();

    const editGroup = document.body.querySelector('.ink-edit-group');
    expect(editGroup?.querySelector('.lucide-shapes')).not.toBeNull();
    expect(editGroup?.querySelectorAll('.bg-edge-default')).toHaveLength(1);
    expect(editGroup?.querySelector('.lucide-ellipsis')).not.toBeNull();
  });

  it('captures hidden grounding before dispatching mixed Ink and objects', async () => {
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [
        {
          id: 'sketch-1',
          type: 'sketch',
          selected: true,
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: 'note-1',
          type: 'note',
          selected: true,
          position: { x: 120, y: 0 },
          data: {},
        },
      ],
    });
    mocks.dispatch.mockResolvedValueOnce({ status: 'completed' });
    const button = await renderToolbar();

    await act(async () => button.click());

    expect(mocks.captureGrounding).toHaveBeenCalledOnce();
    expect(mocks.blobToDataUrl).toHaveBeenCalledWith(expect.any(Blob));
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        groundingVisual: expect.objectContaining({
          dataUrl: 'data:image/png;base64,cG5n',
          selectedNodeIds: ['note-1'],
        }),
      }),
    );
    const input = mocks.prepare.mock.calls[0]?.[0];
    expect(
      agentRequestSchema.safeParse({
        content: input.content,
        inputKind: input.inputKind,
        canvasId: input.sources.canvasId,
        canvasContext: input.sources.canvasContext,
        groundingVisual: input.groundingVisual,
      }),
    ).toMatchObject({ success: true });
  });

  it('tolerates an imperceptible viewport correction during grounding capture', async () => {
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [
        {
          id: 'sketch-1',
          type: 'sketch',
          selected: true,
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: 'note-1',
          type: 'note',
          selected: true,
          position: { x: 120, y: 0 },
          data: {},
        },
      ],
    });
    mocks.getViewport
      .mockReturnValueOnce({ x: 0, y: 0, zoom: 1 })
      .mockReturnValueOnce({ x: 0.25, y: -0.25, zoom: 1 });
    mocks.dispatch.mockResolvedValueOnce({ status: 'completed' });
    const button = await renderToolbar();

    await act(async () => button.click());

    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.dispatch).toHaveBeenCalledOnce();
  });

  it('rejects a visible viewport change during grounding capture', async () => {
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [
        {
          id: 'sketch-1',
          type: 'sketch',
          selected: true,
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: 'note-1',
          type: 'note',
          selected: true,
          position: { x: 120, y: 0 },
          data: {},
        },
      ],
    });
    mocks.getViewport
      .mockReturnValueOnce({ x: 0, y: 0, zoom: 1 })
      .mockReturnValueOnce({ x: 1, y: 0, zoom: 1 });
    const button = await renderToolbar();

    await act(async () => button.click());

    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      'Canvas view changed during Ink grounding capture. Submit again.',
      { tone: 'danger' },
    );
  });

  it('keeps Frame-nested Ink unique and grounds the final source tree', async () => {
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [
        {
          id: 'frame-1',
          type: 'frame',
          selected: true,
          position: { x: 0, y: 0 },
          measured: { width: 800, height: 600 },
          data: {},
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
    mocks.dispatch.mockResolvedValueOnce({ status: 'completed' });
    const button = await renderToolbar();

    await act(async () => button.click());

    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: {
          canvasId: 'canvas-1',
          canvasContext: {
            selectedNodes: [
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
            ],
          },
        },
        groundingVisual: expect.objectContaining({
          selectedNodeIds: ['frame-1'],
          strokeSubsets: [{ nodeId: 'sketch-1', strokeIds: ['stroke-1'] }],
        }),
      }),
    );
  });

  it('requires a choice for multiple conversations regardless of selected Agent Nodes', async () => {
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [
        {
          id: 'question-1',
          type: 'question',
          selected: true,
          position: { x: 0, y: 0 },
          data: { threadId: 'thread-1' },
        },
        {
          id: 'question-2',
          type: 'question',
          selected: true,
          position: { x: 200, y: 0 },
          data: { threadId: 'thread-2' },
        },
        {
          id: 'sketch-1',
          type: 'sketch',
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
    });

    await mountToolbar();

    expect(sendButton().disabled).toBe(true);
    expect(
      document.body.querySelector('[data-picker-target]')?.textContent,
    ).toBe('unresolved');
    await selectConversation('question-2');
    expect(sendButton().disabled).toBe(false);
    expect(document.querySelector('[data-picker-target]')?.textContent).toBe(
      'question-2',
    );
  });

  it('continues an externally bound Question target', async () => {
    useAcpProfilesStore.setState({
      profiles: [
        {
          id: 'profile-1',
          alias: 'Research Agent',
          agentletId: 'agentlet-1',
          workingDirPath: '/tmp',
          launch: { kind: 'acp-command', command: 'agent' },
        },
      ],
    });
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [
        {
          id: 'question-1',
          type: 'question',
          selected: true,
          position: { x: 0, y: 0 },
          data: {
            threadId: 'thread-1',
            agentBinding: {
              kind: 'external',
              profileId: 'profile-1',
              alias: 'External',
            },
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
    mocks.dispatch.mockResolvedValueOnce({ status: 'completed' });

    const button = await renderToolbar();
    await selectConversation();
    expect(
      document.body.querySelector('[data-picker-binding]')?.textContent,
    ).toContain('External');
    await act(async () => button.click());

    expect(button.disabled).toBe(false);
    expect(mocks.createQuestion).not.toHaveBeenCalled();
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        inputKind: 'ink-intent',
        session: expect.objectContaining({ threadId: 'thread-1' }),
      }),
    );
  });

  it('shows the cached Agent name for an unbound compose target', async () => {
    useChatStore.setState({
      bindingByThread: {
        'thread-1': {
          kind: 'external',
          profileId: 'profile-1',
          alias: 'Cached Agent',
        },
      },
      lastActionByThread: { 'thread-1': 'operate' },
    });
    useAcpProfilesStore.setState({
      profiles: [
        {
          id: 'profile-1',
          alias: 'Current Agent',
          agentletId: 'agentlet-1',
          workingDirPath: '/tmp',
          launch: { kind: 'acp-command', command: 'agent' },
        },
      ],
    });
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [
        {
          id: 'question-1',
          type: 'question',
          selected: true,
          position: { x: 0, y: 0 },
          data: { threadId: 'thread-1' },
        },
        {
          id: 'sketch-1',
          type: 'sketch',
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
    });

    await mountToolbar();
    await selectConversation();
    expect(
      document.body.querySelector('[data-picker-binding]')?.textContent,
    ).toContain('Cached Agent');
    const button = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Send ink request"]',
    );
    if (!button) throw new Error('Expected submit button');
    mocks.dispatch.mockResolvedValueOnce({ status: 'completed' });
    await act(async () => button.click());
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'operate' }),
    );
    expect(mocks.listProfiles).not.toHaveBeenCalled();
    expect(mocks.createQuestion).not.toHaveBeenCalled();
  });

  it('continues an internal Question in its persisted ask mode', async () => {
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [
        {
          id: 'question-1',
          type: 'question',
          selected: true,
          position: { x: 0, y: 0 },
          data: {
            threadId: 'thread-1',
            agentBinding: { kind: 'internal' },
            agentMode: 'ask',
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
    mocks.dispatch.mockResolvedValueOnce({ status: 'completed' });
    const button = await renderToolbar();

    await selectConversation();
    await act(async () => button.click());

    expect(mocks.createQuestion).not.toHaveBeenCalled();
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        inputKind: 'ink-intent',
        mode: 'ask',
        session: expect.objectContaining({
          threadId: 'thread-1',
          conversationView: expect.objectContaining({
            conversationOwner: expect.objectContaining({
              nodeId: 'question-1',
            }),
          }),
        }),
      }),
    );
    expect(mocks.listProfiles).not.toHaveBeenCalled();
  });

  it('creates and dispatches at most once for rapid activation', async () => {
    const pending = deferredResult();
    mocks.dispatch.mockReturnValueOnce(pending.promise);
    const button = await renderToolbar();

    await act(async () => {
      button.click();
      button.click();
    });

    expect(mocks.createQuestion).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    const pendingButton = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Sending ink request"]',
    );
    if (!pendingButton) throw new Error('Expected pending Ink button');
    expect(pendingButton.disabled).toBe(true);
    expect(pendingButton.className).toContain('disabled:opacity-50');
    expect(pendingButton.querySelector('.lucide-square')).not.toBeNull();
    expect(pendingButton.querySelector('[data-loading-spinner]')).toBeNull();
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    expect(useGesturePreviewStore.getState().inkSubmissionPreparing).toBe(true);

    pending.resolve({ status: 'rejected' });
    await act(async () => pending.promise);

    const retryButton = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Send ink request"]',
    );
    if (!retryButton) throw new Error('Expected retryable Ink button');
    expect(retryButton.disabled).toBe(false);
    expect(retryButton.querySelector('[data-loading-spinner]')).toBeNull();
    expect(useGesturePreviewStore.getState().inkSubmissionPreparing).toBe(
      false,
    );
  });

  it('reuses the created Question when a rejected selection is retried', async () => {
    mocks.dispatch.mockResolvedValue({ status: 'rejected' });
    const button = await renderToolbar();

    await act(async () => button.click());
    const retryButton = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Send ink request"]',
    );
    if (!retryButton) throw new Error('Expected retryable Ink button');
    await act(async () => retryButton.click());

    expect(mocks.createQuestion).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(mocks.listProfiles).toHaveBeenCalledTimes(1);
  });

  it('retains an ambiguous reservation until Stop confirms no acceptance', async () => {
    let callbacks: AgentTurnCallbacks | undefined;
    mocks.dispatch.mockImplementationOnce(
      (_input: unknown, received: AgentTurnCallbacks) => {
        callbacks = received;
        return Promise.resolve({
          status: 'unknown',
          error: new Error('Connection lost'),
        });
      },
    );
    const button = await renderToolbar();

    await act(async () => button.click());

    expect(useGesturePreviewStore.getState().inkSubmissionPreparing).toBe(true);
    const pendingButton = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Sending ink request"]',
    );
    expect(pendingButton?.disabled).toBe(true);

    act(() => callbacks?.onAcceptanceRejected?.());

    expect(useGesturePreviewStore.getState().inkSubmissionPreparing).toBe(
      false,
    );
    expect(useGesturePreviewStore.getState().sketchStrokeSelection).toEqual({
      'sketch-1': ['stroke-1'],
    });
    const retryButton = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Send ink request"]',
    );
    expect(retryButton?.disabled).toBe(false);
  });

  it('preserves a newer Lasso when the older turn is accepted', async () => {
    const olderPending = deferredResult();
    let callbacks: AgentTurnCallbacks | undefined;
    mocks.dispatch.mockImplementationOnce(
      (_input: unknown, received: AgentTurnCallbacks) => {
        callbacks = received;
        return olderPending.promise;
      },
    );
    const button = await renderToolbar();

    await act(async () => button.click());
    await act(async () => {
      useGesturePreviewStore.setState({
        sketchStrokeSelection: { 'sketch-1': ['stroke-2'] },
        sketchSelectionPolygon: [
          { x: 120, y: 130 },
          { x: 180, y: 130 },
          { x: 180, y: 170 },
          { x: 120, y: 170 },
        ],
      });
      await Promise.resolve();
    });

    expect(useGesturePreviewStore.getState().inkSubmissionPreparing).toBe(
      false,
    );

    act(() =>
      callbacks?.onAccepted?.({ threadId: 'thread-1', turnStartSeq: 1 }),
    );
    olderPending.resolve({
      status: 'completed',
      accepted: { threadId: 'thread-1', turnStartSeq: 1 },
    });
    await act(async () => olderPending.promise);

    expect(useGesturePreviewStore.getState().sketchStrokeSelection).toEqual({
      'sketch-1': ['stroke-2'],
    });
    expect(useGesturePreviewStore.getState().inkSubmissionPreparing).toBe(
      false,
    );
  });

  it('clears the matching Lasso when only whole-node projection changed', async () => {
    const pending = deferredResult();
    let callbacks: AgentTurnCallbacks | undefined;
    mocks.dispatch.mockImplementationOnce(
      (_input: unknown, received: AgentTurnCallbacks) => {
        callbacks = received;
        return pending.promise;
      },
    );
    const button = await renderToolbar();

    await act(async () => button.click());
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [
        {
          id: 'sketch-1',
          type: 'sketch',
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: 'note-1',
          type: 'note',
          selected: true,
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
    });
    act(() =>
      callbacks?.onAccepted?.({ threadId: 'thread-1', turnStartSeq: 1 }),
    );

    expect(useGesturePreviewStore.getState().sketchStrokeSelection).toEqual({});
    expect(
      document.body.querySelector('button[aria-label="Send ink request"]'),
    ).toBeNull();
    pending.resolve({
      status: 'completed',
      accepted: { threadId: 'thread-1', turnStartSeq: 1 },
    });
    await act(async () => pending.promise);
  });

  it('clears the originating selection only after durable acceptance', async () => {
    const pending = deferredResult();
    let callbacks: AgentTurnCallbacks | undefined;
    mocks.dispatch.mockImplementationOnce(
      (_input: unknown, received: AgentTurnCallbacks) => {
        callbacks = received;
        return pending.promise;
      },
    );
    const button = await renderToolbar();

    await act(async () => button.click());
    expect(useGesturePreviewStore.getState().sketchStrokeSelection).toEqual({
      'sketch-1': ['stroke-1'],
    });
    act(() =>
      callbacks?.onAccepted?.({ threadId: 'thread-1', turnStartSeq: 1 }),
    );

    expect(useGesturePreviewStore.getState().sketchStrokeSelection).toEqual({});
    expect(useGesturePreviewStore.getState().inkSubmissionPreparing).toBe(
      false,
    );
    expect(
      document.body.querySelector('button[aria-label="Sending ink request"]'),
    ).toBeNull();
    expect(
      document.body.querySelector('button[aria-label="Send ink request"]'),
    ).toBeNull();
    pending.resolve({
      status: 'completed',
      accepted: { threadId: 'thread-1', turnStartSeq: 1 },
    });
    await act(async () => pending.promise);
  });
});
