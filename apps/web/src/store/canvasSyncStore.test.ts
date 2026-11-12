// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCanvasSyncStore } from './canvasSyncStore';

const mocks = vi.hoisted(() => {
  const canvasState = {
    canvasId: 'canvas-1',
    version: 1,
    isLoading: false,
    nodes: [],
    pendingContentNodeIds: vi.fn(() => []),
    applyDeltasFromAgent: vi.fn(() => []),
    loadCanvas: vi.fn(async () => undefined),
  };
  return { canvasState };
});

vi.mock('@/api/_client', () => ({
  apiErrorFromResponse: vi.fn(),
  getRateLimitRetryAfterSeconds: vi.fn(() => null),
}));
vi.mock('@/api/canvasSync', () => ({
  canvasSyncStreamUrl: (canvasId: string) =>
    `/api/canvas/${canvasId}/sync/stream`,
}));
vi.mock('@/components/Common/Toast', () => ({
  dismissToast: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/hooks/agentStreamCoordinator', () => ({
  hasAgentStreamClaim: vi.fn(() => false),
}));
vi.mock('@/store/acpThreadChangesStore', () => ({
  useAcpThreadChangesStore: {
    getState: () => ({ replaceFromBroadcast: vi.fn() }),
  },
}));
vi.mock('@/store/canvasStore', () => ({
  default: {
    getState: () => mocks.canvasState,
  },
  // The store holds a reload back while edits are waiting to be sent; with
  // nothing queued it reloads at once, which is what this stand-in does.
  requestCanvasResync: (canvasId: string, afterReload?: () => void) => {
    const load = mocks.canvasState.loadCanvas as unknown as (
      canvasId: string,
      options: { resetHistory: boolean },
    ) => Promise<void>;
    void load(canvasId, { resetHistory: true }).then(() => afterReload?.());
  },
}));
vi.mock('@/store/chatStore', () => ({
  useChatStore: {
    getState: () => ({ setHistoryLoaded: vi.fn() }),
  },
}));
vi.mock('@/store/panelStore', () => ({
  usePanelStore: {
    getState: () => ({ requestOpenRightPanel: vi.fn() }),
  },
}));
vi.mock('@/store/previewWorkspace/actions', () => ({
  openPreviewNode: vi.fn(),
}));

const encoder = new TextEncoder();

describe('canvasSyncStore stream recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.canvasState.loadCanvas.mockClear();
    useCanvasSyncStore.setState({ canvasId: null });
  });

  afterEach(() => {
    useCanvasSyncStore.getState().disconnect();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reconnects an inactive stream and heals from the new snapshot', async () => {
    const cancelStalledStream = vi.fn();
    const stalledStream = new ReadableStream<Uint8Array>({
      cancel: cancelStalledStream,
    });
    const recoveredStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('event: snapshot\ndata: {"version":2}\n\n'),
        );
        controller.close();
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(stalledStream))
      .mockResolvedValueOnce(new Response(recoveredStream));
    vi.stubGlobal('fetch', fetchMock);

    useCanvasSyncStore.getState().connect('canvas-1');
    await vi.advanceTimersByTimeAsync(45_500);

    expect(cancelStalledStream).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.canvasState.loadCanvas).toHaveBeenCalledWith('canvas-1', {
      resetHistory: true,
    });
  });

  it('passes order events to the store and reloads when they cannot be installed', async () => {
    const orderEvents = [
      {
        type: 'SET_SIBLING_ORDER',
        parentId: null,
        before: ['a', 'b'],
        after: ['b', 'a'],
        orderVersion: 2,
      },
    ];
    const update = {
      fromVersion: 1,
      toVersion: 2,
      deltas: [],
      pendingEffects: {
        mutatedNodes: [],
        deletedNodeIds: [],
        contentEditedNodeIds: [],
        deferredFitFrameIds: [],
      },
      orderEvents,
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: snapshot\ndata: {"version":1}\n\nevent: update\ndata: ${JSON.stringify(update)}\n\n`,
          ),
        );
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)));
    mocks.canvasState.applyDeltasFromAgent.mockClear();

    useCanvasSyncStore.getState().connect('canvas-1');
    await vi.advanceTimersByTimeAsync(100);

    expect(mocks.canvasState.applyDeltasFromAgent).toHaveBeenCalledOnce();
    const call = mocks.canvasState.applyDeltasFromAgent.mock
      .calls[0] as unknown as [
      unknown[],
      number,
      unknown,
      boolean | undefined,
      { events: unknown; onDiverged: () => void },
    ];
    expect(call[0]).toEqual([]);
    expect(call[1]).toBe(2);
    expect(call[4].events).toEqual(orderEvents);
    expect(mocks.canvasState.loadCanvas).not.toHaveBeenCalled();

    call[4].onDiverged();
    expect(mocks.canvasState.loadCanvas).toHaveBeenCalledWith('canvas-1', {
      resetHistory: true,
    });
  });
});
