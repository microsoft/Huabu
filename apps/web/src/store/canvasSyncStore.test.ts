// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_PAGE_ID } from './canvasStore/sync/pageId';
import {
  CONTENT_REVALIDATE_LIMIT,
  useCanvasSyncStore,
} from './canvasSyncStore';

const mocks = vi.hoisted(() => {
  const canvasState = {
    canvasId: 'canvas-1',
    version: 1,
    isLoading: false,
    nodes: [],
    pendingContentNodeIds: vi.fn(() => []),
    applyDeltasFromAgent: vi.fn(() => []),
    loadCanvas: vi.fn(async () => undefined),
    _setStateNoAutosave: vi.fn(),
  };
  const setSpaceTitle = vi.fn();
  const adoptRemoteNodeContent = vi.fn(async () => []);
  const storeListeners = new Set<(state: typeof canvasState) => void>();
  return {
    canvasState,
    setSpaceTitle,
    adoptRemoteNodeContent,
    storeListeners,
  };
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
    subscribe: (listener: (state: typeof mocks.canvasState) => void) => {
      mocks.storeListeners.add(listener);
      return () => mocks.storeListeners.delete(listener);
    },
  },
  adoptRemoteNodeContent: mocks.adoptRemoteNodeContent,
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
vi.mock('@/store/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({ setSpaceTitle: mocks.setSpaceTitle }),
  },
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

  it('shows a renamed Space and follows its version without loading it again', async () => {
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
      title: 'Renamed elsewhere',
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
    mocks.canvasState._setStateNoAutosave.mockClear();

    useCanvasSyncStore.getState().connect('canvas-1');
    await vi.advanceTimersByTimeAsync(100);

    expect(mocks.canvasState._setStateNoAutosave).toHaveBeenCalledWith({
      canvasTitle: 'Renamed elsewhere',
    });
    expect(mocks.setSpaceTitle).toHaveBeenCalledWith(
      'canvas-1',
      'Renamed elsewhere',
    );
    // The update itself advances the version through the normal path.
    expect(mocks.canvasState.applyDeltasFromAgent).toHaveBeenCalledOnce();
    expect(mocks.canvasState.applyDeltasFromAgent.mock.calls[0]).toEqual(
      expect.arrayContaining([[], 2]),
    );
    expect(mocks.canvasState.loadCanvas).not.toHaveBeenCalled();
  });

  describe('node content saved by another page', () => {
    const connectWith = async (...events: Array<[string, unknown]>) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              events
                .map(
                  ([type, data]) =>
                    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
                )
                .join(''),
            ),
          );
        },
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)));
      useCanvasSyncStore.getState().connect('canvas-1');
      await vi.advanceTimersByTimeAsync(100);
    };

    beforeEach(() => {
      mocks.adoptRemoteNodeContent.mockClear();
      mocks.storeListeners.clear();
      mocks.canvasState.isLoading = false;
      mocks.canvasState.applyDeltasFromAgent.mockClear();
    });

    it("fetches the nodes another page's save names", async () => {
      await connectWith(
        ['snapshot', { version: 1 }],
        ['invalidate', { nodeIds: ['n1'], originPageId: 'another-page' }],
        // A save from a client that does not name itself is fetched too.
        ['invalidate', { nodeIds: ['n2'] }],
      );

      expect(mocks.adoptRemoteNodeContent.mock.calls).toEqual([
        ['canvas-1', ['n1']],
        ['canvas-1', ['n2']],
      ]);
      // Content is not a version change: nothing is replayed or reloaded.
      expect(mocks.canvasState.applyDeltasFromAgent).not.toHaveBeenCalled();
      expect(mocks.canvasState.loadCanvas).not.toHaveBeenCalled();
    });

    it("does not fetch this page's own save or a notice without node ids", async () => {
      await connectWith(
        ['snapshot', { version: 1 }],
        ['invalidate', { nodeIds: ['n1'], originPageId: CANVAS_PAGE_ID }],
        ['invalidate', {}],
        ['invalidate', { nodeIds: [] }],
      );

      expect(mocks.adoptRemoteNodeContent).not.toHaveBeenCalled();
    });

    it('fetches a node saved while the Space was loading once the load ends', async () => {
      mocks.canvasState.isLoading = true;
      await connectWith(
        ['invalidate', { nodeIds: ['n1'], originPageId: 'another-page' }],
        ['invalidate', { nodeIds: ['n1', 'n2'], originPageId: 'another-page' }],
      );
      expect(mocks.adoptRemoteNodeContent).not.toHaveBeenCalled();

      for (const listener of [...mocks.storeListeners])
        listener(mocks.canvasState);
      expect(mocks.adoptRemoteNodeContent).not.toHaveBeenCalled();

      mocks.canvasState.isLoading = false;
      for (const listener of [...mocks.storeListeners])
        listener(mocks.canvasState);
      expect(mocks.adoptRemoteNodeContent.mock.calls).toEqual([
        ['canvas-1', ['n1', 'n2']],
      ]);
      expect(mocks.storeListeners.size).toBe(0);
    });
  });

  describe('node content saved while the stream was down', () => {
    const connectWithSnapshot = async (data: unknown) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: snapshot\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
        },
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)));
      useCanvasSyncStore.getState().connect('canvas-1');
      await vi.advanceTimersByTimeAsync(100);
    };
    const nodesOf = (count: number, type = 'note') =>
      Array.from({ length: count }, (_, index) => ({
        id: `${type}-${index}`,
        type,
      })) as never;

    beforeEach(() => {
      mocks.adoptRemoteNodeContent.mockClear();
      mocks.storeListeners.clear();
      mocks.canvasState.isLoading = false;
      mocks.canvasState.version = 1;
      mocks.canvasState.nodes = [];
    });
    afterEach(() => {
      mocks.canvasState.nodes = [];
    });

    it('fetches the nodes the snapshot names, without loading the Space', async () => {
      await connectWithSnapshot({
        version: 1,
        content: { epoch: 'e', seq: 9, changedNodeIds: ['n1', 'n2'] },
      });
      expect(mocks.adoptRemoteNodeContent.mock.calls).toEqual([
        ['canvas-1', ['n1', 'n2']],
      ]);
      expect(mocks.canvasState.loadCanvas).not.toHaveBeenCalled();
    });

    it('does nothing for a snapshot that names nothing', async () => {
      await connectWithSnapshot({
        version: 1,
        content: { epoch: 'e', seq: 9 },
      });
      expect(mocks.adoptRemoteNodeContent).not.toHaveBeenCalled();
      expect(mocks.canvasState.loadCanvas).not.toHaveBeenCalled();
    });

    it('fetches the named nodes once a load in progress has ended', async () => {
      mocks.canvasState.isLoading = true;
      await connectWithSnapshot({
        version: 5,
        content: { epoch: 'e', seq: 9, changedNodeIds: ['n1'] },
      });
      expect(mocks.adoptRemoteNodeContent).not.toHaveBeenCalled();
      mocks.canvasState.isLoading = false;
      for (const listener of [...mocks.storeListeners])
        listener(mocks.canvasState);
      expect(mocks.adoptRemoteNodeContent.mock.calls).toEqual([
        ['canvas-1', ['n1']],
      ]);
    });

    it('checks every node with saved content, a few at a time, when the server cannot tell', async () => {
      mocks.canvasState.nodes = [
        ...(nodesOf(6) as never[]),
        // A Space card has no saved content of its own.
        ...(nodesOf(2, 'spacePreview') as never[]),
      ] as never;
      await connectWithSnapshot({
        version: 1,
        content: { epoch: 'e2', seq: 0, reset: true },
      });
      expect(mocks.adoptRemoteNodeContent.mock.calls).toEqual([
        ['canvas-1', ['note-0', 'note-1', 'note-2', 'note-3']],
        ['canvas-1', ['note-4', 'note-5']],
      ]);
      expect(mocks.canvasState.loadCanvas).not.toHaveBeenCalled();
    });

    it('loads the Space once instead when it has too many nodes to check one by one', async () => {
      mocks.canvasState.nodes = nodesOf(CONTENT_REVALIDATE_LIMIT + 1);
      await connectWithSnapshot({
        version: 1,
        content: { epoch: 'e2', seq: 0, reset: true },
      });
      expect(mocks.adoptRemoteNodeContent).not.toHaveBeenCalled();
      expect(mocks.canvasState.loadCanvas).toHaveBeenCalledTimes(1);
    });

    it('leaves it to the reload when the version moved as well', async () => {
      mocks.canvasState.nodes = nodesOf(3);
      await connectWithSnapshot({
        version: 2,
        content: { epoch: 'e2', seq: 0, reset: true },
      });
      expect(mocks.adoptRemoteNodeContent).not.toHaveBeenCalled();
      expect(mocks.canvasState.loadCanvas).toHaveBeenCalledTimes(1);
    });
  });
});
