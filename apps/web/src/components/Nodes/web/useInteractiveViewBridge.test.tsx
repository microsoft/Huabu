// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRuntime: vi.fn(),
  replaceState: vi.fn(),
  submitAction: vi.fn(),
}));

vi.mock('@/api/interactiveView', () => ({
  getInteractiveViewRuntime: mocks.getRuntime,
  replaceInteractiveViewState: mocks.replaceState,
  submitInteractiveViewAction: mocks.submitAction,
}));

vi.mock('@/components/Panels/CanvasLayerPanel/focusNodesOnCanvas', () => ({
  focusNodesOnCanvas: vi.fn(),
}));

vi.mock('@/store/canvasStore', () => ({
  default: Object.assign(vi.fn(), {
    getState: () => ({
      nodes: [],
      selectNodes: vi.fn(),
      rfInstance: null,
    }),
  }),
}));

vi.mock('@/store/chatStore', () => ({
  useChatStore: { getState: () => ({ openQuestionThread: vi.fn() }) },
}));

vi.mock('@/store/panelStore', () => ({
  usePanelStore: { getState: () => ({ requestOpenRightPanel: vi.fn() }) },
}));

import { useInteractiveViewBridge } from './useInteractiveViewBridge';

import type { RefObject } from 'react';

class FakeMessagePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly sent: unknown[] = [];
  readonly close = vi.fn();
  readonly start = vi.fn();

  postMessage(value: unknown) {
    this.sent.push(value);
  }

  dispatch(value: unknown) {
    this.onmessage?.({ data: value } as MessageEvent<unknown>);
  }
}

class FakeMessageChannel {
  static latest: FakeMessageChannel | null = null;
  readonly port1 = new FakeMessagePort();
  readonly port2 = new FakeMessagePort();

  constructor() {
    FakeMessageChannel.latest = this;
  }
}

const runtime = {
  resource: {
    nodeId: 'node-view',
    rendererArtifact: 'view.html',
    revision: 'view-rev',
    definition: {
      protocolVersion: 1,
      ownerThreadId: 'thread-owner',
      state: {
        schema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        value: {},
      },
      bindings: [
        {
          bindingId: 'tasks',
          source: { kind: 'canvas.task-store', recentRunLimit: 10 },
          refresh: {
            onMount: true,
            onFocus: true,
            pollIntervalMs: 5_000,
          },
        },
      ],
      actions: [
        {
          actionId: 'refresh',
          kind: 'data.refresh',
          bindingId: 'tasks',
        },
        { actionId: 'submit', kind: 'agent.submit' },
      ],
    },
  },
  data: {
    tasks: {
      revision: 'binding-rev',
      value: { tasks: [], runs: [] },
      references: { nodeIds: [], threadIds: [] },
    },
  },
} as const;

describe('useInteractiveViewBridge', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let unmounted: boolean;
  const contentWindow = { postMessage: vi.fn() };
  const iframeRef = {
    current: { contentWindow },
  } as unknown as RefObject<HTMLIFrameElement | null>;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    unmounted = false;
    vi.useFakeTimers();
    FakeMessageChannel.latest = null;
    vi.stubGlobal('MessageChannel', FakeMessageChannel);
    mocks.getRuntime.mockResolvedValue(runtime);
    mocks.submitAction.mockResolvedValue({ accepted: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (!unmounted) act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('boots one scoped port, rejects replay, dispatches a granted action, and closes on unmount', async () => {
    function Harness() {
      const bridge = useInteractiveViewBridge({
        enabled: true,
        canvasId: 'canvas-a',
        nodeId: 'node-view',
        iframeRef,
      });
      useEffect(() => {
        void bridge.connect();
      }, [bridge]);
      return null;
    }

    await act(async () => {
      root.render(createElement(Harness));
      await Promise.resolve();
    });

    const channel = FakeMessageChannel.latest;
    expect(channel).not.toBeNull();
    expect(contentWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'huabu.view.connect' }),
      '*',
      [channel?.port2],
    );
    expect(channel?.port1.sent).toContainEqual(
      expect.objectContaining({ type: 'huabu.view.bootstrap' }),
    );

    const intent = {
      type: 'huabu.view.intent',
      protocolVersion: 1,
      nodeId: 'node-view',
      requestId: 'request-1',
      actionId: 'submit',
      input: { approved: true },
    };
    await act(async () => {
      channel?.port1.dispatch(intent);
      await Promise.resolve();
    });
    expect(mocks.submitAction).toHaveBeenCalledWith(
      'canvas-a',
      'node-view',
      'submit',
      { input: { approved: true } },
    );
    expect(channel?.port1.sent).toContainEqual(
      expect.objectContaining({
        type: 'huabu.view.outcome',
        requestId: 'request-1',
        status: 'success',
      }),
    );

    channel?.port1.dispatch(intent);
    expect(channel?.port1.sent).toContainEqual(
      expect.objectContaining({
        requestId: 'request-1',
        status: 'error',
        code: 'duplicate_request',
      }),
    );

    for (let index = 2; index <= 21; index += 1) {
      channel?.port1.dispatch({
        ...intent,
        requestId: `request-${index}`,
      });
    }
    expect(channel?.port1.sent).toContainEqual(
      expect.objectContaining({
        requestId: 'request-21',
        status: 'error',
        code: 'rate_limited',
      }),
    );

    channel?.port1.dispatch({
      ...intent,
      requestId: 'request-oversized',
      input: { value: 'x'.repeat(65_537) },
    });
    expect(mocks.submitAction).not.toHaveBeenCalledWith(
      'canvas-a',
      'node-view',
      'submit',
      expect.objectContaining({
        input: expect.objectContaining({ value: expect.any(String) }),
      }),
    );

    act(() => root.unmount());
    unmounted = true;
    expect(channel?.port1.close).toHaveBeenCalledOnce();
  });
});
