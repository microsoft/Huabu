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
});
