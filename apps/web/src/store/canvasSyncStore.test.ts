// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_PAGE_ID } from './canvasStore/sync/pageId';
import { useCanvasSyncStore } from './canvasSyncStore';

import type {
  CanvasContentChangesResponse,
  CanvasContentPosition,
} from '@huabu/shared';

const mocks = vi.hoisted(() => {
  const canvasState = {
    canvasId: 'canvas-1',
    version: 1,
    contentPosition: null as { epoch: string; seq: number } | null,
    isLoading: false,
    nodes: [],
    pendingContentNodeIds: vi.fn(() => []),
    applyServerDeltas: vi.fn(() => []),
    setNodeIngestion: vi.fn(),
    clearNodeIngestion: vi.fn(),
    loadCanvas: vi.fn(async () => undefined),
    _setStateRaw: vi.fn((partial: Record<string, unknown>) => {
      Object.assign(canvasState, partial);
    }),
  };
  const setSpaceTitle = vi.fn();
  const adoptRemoteNodeContent = vi.fn(
    async (_canvasId: string, nodeIds: readonly string[]) =>
      nodeIds.map(() => 'applied'),
  );
  const getCanvasContentChanges = vi.fn();
  const storeListeners = new Set<(state: typeof canvasState) => void>();
  return {
    canvasState,
    setSpaceTitle,
    adoptRemoteNodeContent,
    getCanvasContentChanges,
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
  getCanvasContentChanges: mocks.getCanvasContentChanges,
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
  isDeletedElsewhere: () => false,
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
        mutatedNodeIds: [],
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
    mocks.canvasState.applyServerDeltas.mockClear();

    useCanvasSyncStore.getState().connect('canvas-1');
    await vi.advanceTimersByTimeAsync(100);

    expect(mocks.canvasState.applyServerDeltas).toHaveBeenCalledOnce();
    const call = mocks.canvasState.applyServerDeltas.mock
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
        mutatedNodeIds: [],
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
    mocks.canvasState.applyServerDeltas.mockClear();
    mocks.canvasState._setStateRaw.mockClear();

    useCanvasSyncStore.getState().connect('canvas-1');
    await vi.advanceTimersByTimeAsync(100);

    expect(mocks.canvasState._setStateRaw).toHaveBeenCalledWith({
      canvasTitle: 'Renamed elsewhere',
    });
    expect(mocks.setSpaceTitle).toHaveBeenCalledWith(
      'canvas-1',
      'Renamed elsewhere',
    );
    // The update itself advances the version through the normal path.
    expect(mocks.canvasState.applyServerDeltas).toHaveBeenCalledOnce();
    expect(mocks.canvasState.applyServerDeltas.mock.calls[0]).toEqual(
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
      mocks.canvasState.applyServerDeltas.mockClear();
    });

    it("hands an update's stored content revisions to the store with its deltas", async () => {
      await connectWith(
        ['snapshot', { version: 1 }],
        [
          'update',
          {
            fromVersion: 1,
            toVersion: 2,
            deltas: [],
            pendingEffects: {
              mutatedNodeIds: [],
              deletedNodeIds: [],
              contentEditedNodeIds: [],
              deferredFitFrameIds: [],
            },
            source: 'agent',
            nodeContentRevisions: { n1: 'stored-rev' },
          },
        ],
      );

      expect(mocks.canvasState.applyServerDeltas).toHaveBeenCalledOnce();
      const call = mocks.canvasState.applyServerDeltas.mock
        .calls[0] as unknown as unknown[];
      expect(call[5]).toEqual({
        source: 'agent',
        nodeContentRevisions: { n1: 'stored-rev' },
      });
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
      expect(mocks.canvasState.applyServerDeltas).not.toHaveBeenCalled();
      expect(mocks.canvasState.loadCanvas).not.toHaveBeenCalled();
    });

    it('shows preprocessing the server announces until it ends, and forgets it on a new connection', async () => {
      mocks.canvasState.setNodeIngestion.mockClear();
      mocks.canvasState.clearNodeIngestion.mockClear();
      await connectWith(
        ['snapshot', { version: 1 }],
        ['preprocess', { nodeId: 'n1', status: 'pending' }],
        ['preprocess', { nodeId: 'n2', status: 'pending' }],
        ['preprocess', { nodeId: 'n3', status: 'pending' }],
        ['preprocess', { nodeId: 'n1', status: 'done' }],
        ['preprocess', { nodeId: 'n2', status: 'error', error: 'no text' }],
        // The connection is replaced before n3's end is heard.
        ['snapshot', { version: 1 }],
      );

      expect(mocks.canvasState.setNodeIngestion.mock.calls).toEqual([
        ['n1', { status: 'pending' }],
        ['n2', { status: 'pending' }],
        ['n3', { status: 'pending' }],
      ]);
      // A run that ended, a run that failed, and one whose end was missed.
      expect(mocks.canvasState.clearNodeIngestion.mock.calls).toEqual([
        ['n1'],
        ['n2'],
        ['n3'],
      ]);
      // A status is not a version change: nothing is replayed or reloaded.
      expect(mocks.canvasState.applyServerDeltas).not.toHaveBeenCalled();
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
      // The wait for the load is over; only the connection's own watch of
      // loads is left.
      expect(mocks.storeListeners.size).toBe(1);
    });
  });

  describe('node content saved before the stream was open', () => {
    const LOADED: CanvasContentPosition = { epoch: 'e', seq: 4 };
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
    const answer = (response: CanvasContentChangesResponse) =>
      mocks.getCanvasContentChanges.mockResolvedValueOnce(response);
    /** The store finishes a load that brought `version` and `position`. */
    const endLoad = async (
      version: number,
      position: CanvasContentPosition | null,
    ) => {
      mocks.canvasState.version = version;
      mocks.canvasState.contentPosition = position;
      mocks.canvasState.isLoading = false;
      for (const listener of [...mocks.storeListeners])
        listener(mocks.canvasState);
      await vi.advanceTimersByTimeAsync(100);
    };

    beforeEach(() => {
      mocks.adoptRemoteNodeContent.mockClear();
      mocks.getCanvasContentChanges.mockReset();
      mocks.getCanvasContentChanges.mockResolvedValue({
        position: { epoch: 'e', seq: 9 },
      });
      mocks.storeListeners.clear();
      mocks.canvasState.isLoading = false;
      mocks.canvasState.version = 1;
      mocks.canvasState.contentPosition = LOADED;
      mocks.canvasState.nodes = [];
    });
    afterEach(() => {
      mocks.canvasState.nodes = [];
      mocks.canvasState.contentPosition = null;
    });

    it('asks from the position the load brought when the stream first opens, and fetches what was saved since', async () => {
      // The Space was loaded, then the stream opened: a save in between
      // reached no stream.
      answer({
        position: { epoch: 'e', seq: 9 },
        changedNodeIds: ['n1', 'n2'],
      });
      await connectWithSnapshot({ version: 1 });

      expect(mocks.getCanvasContentChanges.mock.calls).toEqual([
        ['canvas-1', LOADED],
      ]);
      expect(mocks.adoptRemoteNodeContent.mock.calls).toEqual([
        ['canvas-1', ['n1', 'n2']],
      ]);
      // The next check asks from where this one ended.
      expect(mocks.canvasState.contentPosition).toEqual({ epoch: 'e', seq: 9 });
      expect(mocks.canvasState.loadCanvas).not.toHaveBeenCalled();
    });

    it('fetches nothing when nothing was saved since, and still moves the position on', async () => {
      await connectWithSnapshot({ version: 1 });
      expect(mocks.adoptRemoteNodeContent).not.toHaveBeenCalled();
      expect(mocks.canvasState.contentPosition).toEqual({ epoch: 'e', seq: 9 });
      expect(mocks.canvasState.loadCanvas).not.toHaveBeenCalled();
    });

    it('asks once the load in flight ends, from the position that load brought', async () => {
      // The stream opened first; the load's read may predate a save that
      // predates the subscription.
      mocks.canvasState.isLoading = true;
      mocks.canvasState.contentPosition = null;
      await connectWithSnapshot({ version: 5 });
      expect(mocks.getCanvasContentChanges).not.toHaveBeenCalled();

      answer({ position: { epoch: 'e', seq: 12 }, changedNodeIds: ['n1'] });
      await endLoad(5, { epoch: 'e', seq: 11 });
      expect(mocks.getCanvasContentChanges.mock.calls).toEqual([
        ['canvas-1', { epoch: 'e', seq: 11 }],
      ]);
      expect(mocks.adoptRemoteNodeContent.mock.calls).toEqual([
        ['canvas-1', ['n1']],
      ]);
      expect(mocks.canvasState.loadCanvas).not.toHaveBeenCalled();
    });

    it('loads again when the load in flight ends behind the version the stream named', async () => {
      // The load read version 4; a commit made it 5 before the stream was
      // subscribed, so no update for it was ever sent to this page.
      mocks.canvasState.isLoading = true;
      await connectWithSnapshot({ version: 5 });
      await endLoad(4, LOADED);
      expect(mocks.canvasState.loadCanvas).toHaveBeenCalledTimes(1);
      expect(mocks.getCanvasContentChanges).not.toHaveBeenCalled();

      // That load brings version 5: nothing more to reload, content is asked.
      mocks.canvasState.isLoading = true;
      for (const listener of [...mocks.storeListeners])
        listener(mocks.canvasState);
      await endLoad(5, { epoch: 'e', seq: 6 });
      expect(mocks.canvasState.loadCanvas).toHaveBeenCalledTimes(1);
      expect(mocks.getCanvasContentChanges.mock.calls).toEqual([
        ['canvas-1', { epoch: 'e', seq: 6 }],
      ]);
    });

    it('does not load again and again when a load cannot reach the version named', async () => {
      mocks.canvasState.isLoading = true;
      await connectWithSnapshot({ version: 5 });
      await endLoad(4, LOADED);
      mocks.canvasState.isLoading = true;
      for (const listener of [...mocks.storeListeners])
        listener(mocks.canvasState);
      await endLoad(4, LOADED);
      expect(mocks.canvasState.loadCanvas).toHaveBeenCalledTimes(1);
    });

    it('asks again after a reload that ends with the stream open', async () => {
      await connectWithSnapshot({ version: 1 });
      mocks.getCanvasContentChanges.mockClear();

      mocks.canvasState.isLoading = true;
      for (const listener of [...mocks.storeListeners])
        listener(mocks.canvasState);
      await endLoad(1, { epoch: 'e', seq: 20 });
      expect(mocks.getCanvasContentChanges.mock.calls).toEqual([
        ['canvas-1', { epoch: 'e', seq: 20 }],
      ]);
    });

    it('keeps the position and asks again when the check or a fetch fails', async () => {
      mocks.getCanvasContentChanges.mockRejectedValueOnce(new Error('offline'));
      await connectWithSnapshot({ version: 1 });
      expect(mocks.canvasState.contentPosition).toEqual(LOADED);

      // The retry names a node whose fetch then fails once.
      answer({ position: { epoch: 'e', seq: 9 }, changedNodeIds: ['n1'] });
      mocks.adoptRemoteNodeContent.mockResolvedValueOnce(['failed']);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.canvasState.contentPosition).toEqual(LOADED);

      answer({ position: { epoch: 'e', seq: 9 }, changedNodeIds: ['n1'] });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mocks.getCanvasContentChanges.mock.calls).toEqual([
        ['canvas-1', LOADED],
        ['canvas-1', LOADED],
        ['canvas-1', LOADED],
      ]);
      expect(mocks.canvasState.contentPosition).toEqual({ epoch: 'e', seq: 9 });
    });

    it('checks every node with saved content, a few at a time, when the server cannot tell', async () => {
      mocks.canvasState.nodes = [
        ...(nodesOf(6) as never[]),
        // A Space card has no saved content of its own.
        ...(nodesOf(2, 'spacePreview') as never[]),
      ] as never;
      answer({ position: { epoch: 'e2', seq: 0 }, reset: true });
      await connectWithSnapshot({ version: 1 });
      expect(mocks.adoptRemoteNodeContent.mock.calls).toEqual([
        ['canvas-1', ['note-0', 'note-1', 'note-2', 'note-3']],
        ['canvas-1', ['note-4', 'note-5']],
      ]);
      expect(mocks.canvasState.contentPosition).toEqual({
        epoch: 'e2',
        seq: 0,
      });
      expect(mocks.canvasState.loadCanvas).not.toHaveBeenCalled();
    });

    it('checks a large Space the same way, without loading it again', async () => {
      mocks.canvasState.nodes = nodesOf(450);
      answer({ position: { epoch: 'e2', seq: 0 }, reset: true });
      await connectWithSnapshot({ version: 1 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(
        mocks.adoptRemoteNodeContent.mock.calls.flatMap(([, ids]) => ids),
      ).toHaveLength(450);
      expect(
        mocks.adoptRemoteNodeContent.mock.calls.every(
          ([, ids]) => ids.length <= 4,
        ),
      ).toBe(true);
      expect(mocks.canvasState.contentPosition).toEqual({
        epoch: 'e2',
        seq: 0,
      });
      expect(mocks.canvasState.loadCanvas).not.toHaveBeenCalled();
    });

    it('leaves it to the reload when the version moved as well and the reload starts', async () => {
      mocks.canvasState.nodes = nodesOf(3);
      // The real store is loading from the moment the reload begins.
      mocks.canvasState.loadCanvas.mockImplementationOnce(async () => {
        mocks.canvasState.isLoading = true;
      });
      await connectWithSnapshot({ version: 2 });
      expect(mocks.canvasState.loadCanvas).toHaveBeenCalledTimes(1);
      expect(mocks.getCanvasContentChanges).not.toHaveBeenCalled();
      for (const listener of [...mocks.storeListeners])
        listener(mocks.canvasState);

      // The reload's end asks, from the position it brought.
      await endLoad(2, { epoch: 'e', seq: 30 });
      expect(mocks.getCanvasContentChanges.mock.calls).toEqual([
        ['canvas-1', { epoch: 'e', seq: 30 }],
      ]);
    });

    it('still asks when the version moved but the reload is held back', async () => {
      // Unsent edits or unsaved text hold the reload; content saved by
      // other pages does not wait for it.
      mocks.canvasState.loadCanvas.mockImplementationOnce(
        async () => undefined,
      );
      answer({ position: { epoch: 'e', seq: 9 }, changedNodeIds: ['n1'] });
      await connectWithSnapshot({ version: 2 });
      expect(mocks.adoptRemoteNodeContent.mock.calls).toEqual([
        ['canvas-1', ['n1']],
      ]);
    });
  });
});
