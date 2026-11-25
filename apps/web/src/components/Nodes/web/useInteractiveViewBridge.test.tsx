// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/_client';

const mocks = vi.hoisted(() => ({
  getRuntime: vi.fn(),
  replaceState: vi.fn(),
  replaceDataNode: vi.fn(),
  submitAction: vi.fn(),
  adoptRemoteNodeContent: vi.fn(),
  syncListener: null as ((event: unknown) => void) | null,
}));

vi.mock('@/api/interactiveView', () => ({
  getInteractiveViewRuntime: mocks.getRuntime,
  replaceInteractiveViewState: mocks.replaceState,
  replaceInteractiveViewDataNode: mocks.replaceDataNode,
  submitInteractiveViewAction: mocks.submitAction,
}));

vi.mock('@/utils/canvasViewport', () => ({
  revealNodesOnCanvas: vi.fn(),
}));

vi.mock('@/store/canvasStore', () => ({
  default: Object.assign(vi.fn(), {
    subscribe: () => () => {},
    getState: () => ({
      nodes: [],
      selectNodes: vi.fn(),
      rfInstance: null,
    }),
  }),
  adoptRemoteNodeContent: mocks.adoptRemoteNodeContent,
}));

vi.mock('@/store/canvasSyncSubscription', () => ({
  subscribeCanvasSync: (
    _canvasId: string,
    listener: (event: unknown) => void,
  ) => {
    mocks.syncListener = listener;
    return () => {
      if (mocks.syncListener === listener) {
        mocks.syncListener = null;
      }
    };
  },
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
    iframeRef.current = { contentWindow } as unknown as HTMLIFrameElement;
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

  it('connects once per iframe, closes on navigation, and reconnects only for a new element', async () => {
    let bridge: ReturnType<typeof useInteractiveViewBridge>;
    function Harness({ enabled = true }) {
      bridge = useInteractiveViewBridge({
        enabled,
        canvasId: 'canvas-a',
        nodeId: 'node-view',
        iframeRef,
      });
      return null;
    }
    await act(async () => root.render(createElement(Harness)));
    await act(async () => bridge.onLoad());
    const first = FakeMessageChannel.latest;
    expect(mocks.getRuntime).toHaveBeenCalledOnce();
    act(() => bridge.onLoad());
    expect(first?.port1.close).toHaveBeenCalledOnce();
    expect(mocks.getRuntime).toHaveBeenCalledOnce();
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      window.dispatchEvent(new Event('focus'));
    });
    expect(mocks.getRuntime).toHaveBeenCalledOnce();

    iframeRef.current = { contentWindow } as unknown as HTMLIFrameElement;
    await act(async () => bridge.onLoad());
    expect(mocks.getRuntime).toHaveBeenCalledTimes(2);
    const second = FakeMessageChannel.latest;
    expect(second).not.toBe(first);
    await act(async () =>
      root.render(createElement(Harness, { enabled: false })),
    );
    expect(second?.port1.close).toHaveBeenCalledOnce();
    act(() => bridge.onLoad());
    expect(mocks.getRuntime).toHaveBeenCalledTimes(2);
  });

  it('does not send an in-flight bootstrap to a replacement iframe', async () => {
    let resolveRuntime!: (value: typeof runtime) => void;
    mocks.getRuntime.mockReturnValue(
      new Promise<typeof runtime>((resolve) => {
        resolveRuntime = resolve;
      }),
    );
    let bridge: ReturnType<typeof useInteractiveViewBridge>;
    function Harness() {
      bridge = useInteractiveViewBridge({
        enabled: true,
        canvasId: 'canvas-a',
        nodeId: 'node-view',
        iframeRef,
      });
      return null;
    }
    act(() => root.render(createElement(Harness)));
    act(() => bridge.onLoad());
    iframeRef.current = { contentWindow } as unknown as HTMLIFrameElement;
    await act(async () => resolveRuntime(runtime));
    expect(FakeMessageChannel.latest).toBeNull();
    expect(contentWindow.postMessage).not.toHaveBeenCalled();
  });

  it('reports bootstrap failure and recovers only after a fresh iframe load', async () => {
    const error = new Error('Runtime unavailable');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onBootstrapError = vi.fn();
    mocks.getRuntime.mockRejectedValueOnce(error);
    let bridge: ReturnType<typeof useInteractiveViewBridge>;
    function Harness() {
      bridge = useInteractiveViewBridge({
        enabled: true,
        canvasId: 'canvas-a',
        nodeId: 'node-view',
        iframeRef,
        onBootstrapError,
      });
      return null;
    }
    await act(async () => root.render(createElement(Harness)));
    await act(async () => bridge.onLoad());
    expect(onBootstrapError).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      '[interactive-view] bootstrap failed',
      error,
    );
    expect(FakeMessageChannel.latest).toBeNull();
    await act(async () => bridge.onLoad());
    expect(mocks.getRuntime).toHaveBeenCalledOnce();
    iframeRef.current = { contentWindow } as unknown as HTMLIFrameElement;
    await act(async () => bridge.onLoad());
    expect(FakeMessageChannel.latest?.port1.sent[0]).toMatchObject({
      type: 'huabu.view.bootstrap',
    });
    expect(onBootstrapError).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it.each(['replacement', 'disabled', 'unmounted'])(
    'ignores a stale bootstrap rejection after %s',
    async (change) => {
      let rejectRuntime!: (error: Error) => void;
      mocks.getRuntime.mockReturnValue(
        new Promise((_, reject) => {
          rejectRuntime = reject;
        }),
      );
      const onBootstrapError = vi.fn();
      let bridge: ReturnType<typeof useInteractiveViewBridge>;
      function Harness({ enabled = true }) {
        bridge = useInteractiveViewBridge({
          enabled,
          canvasId: 'canvas-a',
          nodeId: 'node-view',
          iframeRef,
          onBootstrapError,
        });
        return null;
      }
      await act(async () => root.render(createElement(Harness)));
      act(() => bridge.onLoad());
      if (change === 'replacement') {
        iframeRef.current = { contentWindow } as unknown as HTMLIFrameElement;
      } else if (change === 'disabled') {
        await act(async () =>
          root.render(createElement(Harness, { enabled: false })),
        );
      } else {
        act(() => root.unmount());
        unmounted = true;
      }
      await act(async () => rejectRuntime(new Error('Stale failure')));
      expect(onBootstrapError).not.toHaveBeenCalled();
    },
  );

  it('dispatches data.replace with CAS revision, handles 409 conflicts, and refreshes on CanvasSync invalidate', async () => {
    const formRuntime = {
      resource: {
        nodeId: 'node-view',
        rendererArtifact: 'form.html',
        revision: 'view-rev-1',
        definition: {
          protocolVersion: 1,
          state: { schema: { type: 'null' }, value: null },
          bindings: [
            {
              bindingId: 'cfg',
              source: { kind: 'data-node', nodeId: 'node-data-1' },
            },
          ],
          actions: [
            {
              actionId: 'save-cfg',
              kind: 'data.replace',
              bindingId: 'cfg',
            },
          ],
        },
      },
      data: {
        cfg: {
          revision: 'rev-1',
          value: {
            status: 'ready',
            nodeId: 'node-data-1',
            label: 'Config',
            value: { repo: 'microsoft/Huabu' },
            schema: {
              type: 'object',
              properties: { repo: { type: 'string' } },
              required: ['repo'],
              additionalProperties: false,
            },
          },
          references: { nodeIds: ['node-data-1'], threadIds: [] },
        },
      },
    } as const;

    mocks.getRuntime.mockResolvedValue(formRuntime);
    mocks.adoptRemoteNodeContent.mockResolvedValue(undefined);
    mocks.replaceDataNode.mockResolvedValueOnce({
      bindingId: 'cfg',
      nodeId: 'node-data-1',
      snapshot: {
        revision: 'rev-2',
        value: {
          status: 'ready',
          nodeId: 'node-data-1',
          label: 'Config',
          value: { repo: 'microsoft/Next' },
          schema: formRuntime.data.cfg.value.schema,
        },
        references: { nodeIds: ['node-data-1'], threadIds: [] },
      },
    });

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
    expect(channel?.port1.sent).toContainEqual(
      expect.objectContaining({
        type: 'huabu.view.bootstrap',
        actions: [
          { actionId: 'save-cfg', kind: 'data.replace', bindingId: 'cfg' },
        ],
      }),
    );

    await act(async () => {
      channel?.port1.dispatch({
        type: 'huabu.view.intent',
        protocolVersion: 1,
        nodeId: 'node-view',
        requestId: 'req-save-1',
        actionId: 'save-cfg',
        input: {
          revision: 'rev-1',
          value: { repo: 'microsoft/Next' },
        },
      });
      await Promise.resolve();
    });

    expect(mocks.replaceDataNode).toHaveBeenCalledWith(
      'canvas-a',
      'node-view',
      'cfg',
      {
        revision: 'rev-1',
        value: { repo: 'microsoft/Next' },
      },
    );
    expect(mocks.adoptRemoteNodeContent).toHaveBeenCalledWith('canvas-a', [
      'node-data-1',
    ]);
    expect(channel?.port1.sent).toContainEqual(
      expect.objectContaining({
        type: 'huabu.view.outcome',
        requestId: 'req-save-1',
        status: 'success',
        data: expect.objectContaining({
          cfg: expect.objectContaining({ revision: 'rev-2' }),
        }),
      }),
    );

    // 409 conflict preserves server currentRevision + currentValue in outcome.details
    mocks.replaceDataNode.mockRejectedValueOnce(
      new ApiError(
        409,
        {
          code: 'data_node_conflict',
          message: 'Revision mismatch',
          details: {
            currentRevision: 'rev-3',
            currentValue: { repo: 'microsoft/Remote' },
          },
        },
        'Revision mismatch',
      ),
    );

    await act(async () => {
      channel?.port1.dispatch({
        type: 'huabu.view.intent',
        protocolVersion: 1,
        nodeId: 'node-view',
        requestId: 'req-save-conflict',
        actionId: 'save-cfg',
        input: {
          revision: 'rev-1',
          value: { repo: 'microsoft/Stale' },
        },
      });
      await Promise.resolve();
    });

    expect(channel?.port1.sent).toContainEqual(
      expect.objectContaining({
        type: 'huabu.view.outcome',
        requestId: 'req-save-conflict',
        status: 'conflict',
        code: 'data_node_conflict',
        details: {
          currentRevision: 'rev-3',
          currentValue: { repo: 'microsoft/Remote' },
        },
      }),
    );

    // Live CanvasSync invalidate for bound data-node triggers runtime refresh
    mocks.getRuntime.mockResolvedValueOnce({
      ...formRuntime,
      data: {
        cfg: {
          revision: 'rev-4',
          value: {
            ...formRuntime.data.cfg.value,
            value: { repo: 'microsoft/AgentUpdated' },
          },
        },
      },
    });
    await act(async () => {
      mocks.syncListener?.({
        type: 'invalidate',
        data: {
          canvasId: 'canvas-a',
          nodeIds: ['node-data-1'],
        },
      });
      await Promise.resolve();
    });
    expect(channel?.port1.sent).toContainEqual(
      expect.objectContaining({
        type: 'huabu.view.data',
        data: expect.objectContaining({
          cfg: expect.objectContaining({ revision: 'rev-4' }),
        }),
      }),
    );
  });
});
