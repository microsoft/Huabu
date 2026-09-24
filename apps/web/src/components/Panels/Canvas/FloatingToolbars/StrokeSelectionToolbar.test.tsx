// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { agentRequestSchema } from '@huabu/shared';

import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import { StrokeSelectionToolbar } from './StrokeSelectionToolbar';

import type {
  AgentTurnCallbacks,
  AgentTurnResult,
} from '@/hooks/agentTurnController';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  prepare: vi.fn(),
  dispatch: vi.fn(),
  createQuestion: vi.fn(),
  placement: vi.fn(),
  captureGrounding: vi.fn(),
  blobToDataUrl: vi.fn(),
  getViewport: vi.fn(),
  popoverAnchor: null as unknown,
}));

vi.mock('@xyflow/react', async (original) => ({
  ...((await original()) as object),
  useReactFlow: () => ({ getViewport: mocks.getViewport }),
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
      children,
    }: {
      anchor: unknown;
      open: boolean;
      children: React.ReactNode;
    }) => {
      mocks.popoverAnchor = anchor;
      return open ? createElement('div', null, children) : null;
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

function deferredResult() {
  let resolve!: (result: AgentTurnResult) => void;
  const promise = new Promise<AgentTurnResult>((done) => {
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
  const button = document.body.querySelector<HTMLButtonElement>('button');
  if (!button) throw new Error('Expected toolbar button');
  return button;
}

beforeEach(() => {
  vi.clearAllMocks();
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
  });
  useChatStore.setState({
    threadsById: {},
    bindingByThread: {},
    settingsByThread: {},
    lastActionByThread: {},
  });
  useAcpProfilesStore.setState({ profiles: [] });
  useGesturePreviewStore.setState({
    sketchStrokeSelection: { 'sketch-1': ['stroke-1'] },
    sketchSelectionPolygon: [
      { x: 20, y: 30 },
      { x: 80, y: 30 },
      { x: 80, y: 70 },
      { x: 20, y: 70 },
    ],
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
  it('keeps submit and source count visible for a mixed selection', async () => {
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

    expect(document.body.textContent).toContain('2 sources');
    expect(document.body.textContent).toContain('New · Huabu');
    expect(document.body.querySelector('[data-sketch-controls]')).toBeNull();
    const submit = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Send ink request"]',
    );
    expect(submit?.disabled).toBe(false);
    expect(submit?.className).toContain('bg-inverse');
    expect(submit?.className).toContain('rounded-full');
    expect(mocks.popoverAnchor).toEqual({
      x: 20,
      y: 30,
      width: 60,
      height: 40,
    });
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

  it('exposes a disabled explanation for multiple Agent Node targets', async () => {
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

    const button = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Select only one Agent Node to continue"]',
    );
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute('aria-label')).toBe(
      'Select only one Agent Node to continue',
    );
    expect(document.body.textContent).toContain('Multiple agents');
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
    expect(document.body.textContent).toContain('Research Agent');
    expect(
      document.body.querySelector(
        '[aria-label="Target agent: Research Agent"]',
      ),
    ).not.toBeNull();
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

    expect(document.body.textContent).toContain('Current Agent');
    expect(document.body.textContent).not.toContain('New · Huabu');
    const button = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Send ink request"]',
    );
    if (!button) throw new Error('Expected submit button');
    mocks.dispatch.mockResolvedValueOnce({ status: 'completed' });
    await act(async () => button.click());
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'operate' }),
    );
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
  });

  it('creates and dispatches at most once for rapid activation', async () => {
    const pending = deferredResult();
    mocks.dispatch.mockReturnValueOnce(pending.promise);
    const button = await renderToolbar();

    act(() => {
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
    const spinner = pendingButton.querySelector<HTMLElement>(
      '[data-loading-spinner]',
    );
    expect(spinner).not.toBeNull();
    expect(spinner?.style.width).toBe('12px');
    expect(spinner?.style.height).toBe('12px');
    expect(spinner?.querySelector('.animate-spin')).not.toBeNull();
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

    act(() => button.click());
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

    act(() => button.click());
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

    act(() => button.click());
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
