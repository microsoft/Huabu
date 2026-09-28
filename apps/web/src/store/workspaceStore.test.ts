// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resolveFolderPickerSupported,
  useWorkspaceStore,
} from './workspaceStore';
import { listCanvases } from '../api/canvas';

import type { WorkspaceDescriptor, WorkspaceInfo } from '../api/workspace';
import type { ListCanvasesResponse } from '@huabu/shared';

const FIRST_ID = '00000000-0000-4000-8000-000000000001';
const SECOND_ID = '00000000-0000-4000-8000-000000000002';

const apiState = vi.hoisted(() => ({
  info: null as WorkspaceInfo | null,
  workspaces: [] as WorkspaceDescriptor[],
}));

const apiMocks = vi.hoisted(() => ({
  getWorkspaceInfo: vi.fn(async () => apiState.info as WorkspaceInfo),
  listWorkspaces: vi.fn(async () => apiState.workspaces),
  activateWorkspace: vi.fn(async (workspaceId: string) => {
    const selected = apiState.workspaces.find(
      (workspace) => workspace.workspaceId === workspaceId,
    );
    if (!selected) throw new Error('Workspace not found');
    apiState.workspaces = apiState.workspaces.map((workspace) => ({
      ...workspace,
      active: workspace.workspaceId === workspaceId,
    }));
    apiState.info = {
      ...(apiState.info as WorkspaceInfo),
      configured: true,
      workspaceId: selected.workspaceId,
      path: selected.path,
      name: selected.name,
    };
    return { ...selected, active: true };
  }),
  putWorkspacePath: vi.fn(),
  removeWorkspace: vi.fn(async (workspaceId: string) => {
    apiState.workspaces = apiState.workspaces.filter(
      (workspace) => workspace.workspaceId !== workspaceId,
    );
  }),
}));

vi.mock('../api/canvas', () => ({
  listCanvases: vi.fn(async () => ({ canvases: [] })),
}));

vi.mock('../api/workspace', () => ({
  getWorkspaceInfo: apiMocks.getWorkspaceInfo,
  listWorkspaces: apiMocks.listWorkspaces,
  activateWorkspace: apiMocks.activateWorkspace,
  putWorkspacePath: apiMocks.putWorkspacePath,
  removeWorkspace: apiMocks.removeWorkspace,
}));

function unconfiguredInfo(): WorkspaceInfo {
  return {
    mode: 'free',
    configured: false,
    workspaceId: null,
    path: null,
    name: null,
    worldCanvasId: null,
    capabilities: { canChangeWorkspace: true, nativePicker: false },
  };
}

function descriptors(): WorkspaceDescriptor[] {
  return [
    {
      workspaceId: SECOND_ID,
      name: 'Second',
      path: '/tmp/second',
      active: false,
    },
    {
      workspaceId: FIRST_ID,
      name: 'First',
      path: '/tmp/first',
      active: false,
    },
  ];
}

describe('workspace folder picker support', () => {
  it('never offers a client-machine picker in remote Electron mode', () => {
    expect(
      resolveFolderPickerSupported(true, {
        isRemoteServer: true,
      }),
    ).toBe(false);
  });

  it('uses the local Electron bridge or the browser Server capability', () => {
    expect(
      resolveFolderPickerSupported(false, {
        isRemoteServer: false,
        dialog: {},
      }),
    ).toBe(true);
    expect(resolveFolderPickerSupported(true, null)).toBe(true);
    expect(resolveFolderPickerSupported(false, null)).toBe(false);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function spaces(title: string | null): ListCanvasesResponse {
  return {
    canvases: [
      {
        canvasId: 'target',
        title,
        nodeCount: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
}

describe('workspace Space metadata', () => {
  beforeEach(() => {
    vi.mocked(listCanvases).mockReset();
    apiState.info = {
      ...unconfiguredInfo(),
      configured: true,
      workspaceId: FIRST_ID,
      path: '/workspaces/first',
    };
    apiState.workspaces = descriptors();
    useWorkspaceStore.setState({
      mode: 'free',
      workspaceId: FIRST_ID,
      workspacePath: '/workspaces/first',
      recentWorkspaces: descriptors(),
      isReady: true,
      isSyncing: false,
      spaceTitles: {},
      spaceSummaries: {},
      spaceTitlesStatus: 'idle',
      spaceTitlesError: null,
      canvasCount: null,
    });
  });

  it('coalesces list requests and preserves membership for untitled Spaces', async () => {
    const response = deferred<ListCanvasesResponse>();
    vi.mocked(listCanvases).mockReturnValueOnce(response.promise);
    const first = useWorkspaceStore.getState().refreshSpaceTitles();
    const second = useWorkspaceStore.getState().refreshSpaceTitles();
    expect(first).toBe(second);
    expect(useWorkspaceStore.getState().spaceTitlesStatus).toBe('loading');
    response.resolve(spaces(null));
    await first;
    expect(listCanvases).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState()).toMatchObject({
      spaceTitles: { target: null },
      spaceSummaries: { target: { nodeCount: 0, updatedAt: 1 } },
      spaceTitlesStatus: 'ready',
      spaceTitlesError: null,
      canvasCount: 1,
    });
  });

  it('surfaces failed refreshes without discarding the last title, then retries', async () => {
    vi.mocked(listCanvases).mockResolvedValueOnce(spaces('Before'));
    await useWorkspaceStore.getState().refreshSpaceTitles();
    vi.mocked(listCanvases).mockRejectedValueOnce(new Error('Offline'));
    await useWorkspaceStore.getState().refreshSpaceTitles();
    expect(useWorkspaceStore.getState()).toMatchObject({
      spaceTitles: { target: 'Before' },
      spaceSummaries: { target: { nodeCount: 0, updatedAt: 1 } },
      spaceTitlesStatus: 'error',
      spaceTitlesError: 'Offline',
    });
    vi.mocked(listCanvases).mockResolvedValueOnce(spaces('Renamed elsewhere'));
    await useWorkspaceStore.getState().refreshSpaceTitles();
    expect(useWorkspaceStore.getState()).toMatchObject({
      spaceTitles: { target: 'Renamed elsewhere' },
      spaceTitlesStatus: 'ready',
      spaceTitlesError: null,
    });
  });

  it('does not revert a local rename with a list started before it', async () => {
    const response = deferred<ListCanvasesResponse>();
    vi.mocked(listCanvases).mockReturnValueOnce(response.promise);
    const pending = useWorkspaceStore.getState().refreshSpaceTitles();
    useWorkspaceStore.getState().setSpaceTitle('target', 'Local rename');
    response.resolve(spaces('Old title'));
    await pending;
    expect(useWorkspaceStore.getState().spaceTitles.target).toBe(
      'Local rename',
    );
    vi.mocked(listCanvases).mockResolvedValueOnce(
      spaces('Later server rename'),
    );
    await useWorkspaceStore.getState().refreshSpaceTitles();
    expect(useWorkspaceStore.getState().spaceTitles.target).toBe(
      'Later server rename',
    );
  });

  it('invalidates changed summaries and coalesces a fresh read after an older in-flight list', async () => {
    useWorkspaceStore.setState({
      spaceTitles: { target: 'Before' },
      spaceSummaries: { target: { nodeCount: 2, updatedAt: 1 } },
    });
    const old = deferred<ListCanvasesResponse>();
    const fresh = spaces('After');
    fresh.canvases[0].nodeCount = 24;
    fresh.canvases[0].updatedAt = 2345;
    vi.mocked(listCanvases)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(fresh);
    const pending = useWorkspaceStore.getState().refreshSpaceTitles();
    const changed = useWorkspaceStore.getState().refreshSpaceTitles(['target']);
    expect(changed).toBe(pending);
    expect(useWorkspaceStore.getState().spaceSummaries.target).toBeUndefined();
    expect(useWorkspaceStore.getState().spaceTitles.target).toBe('Before');
    old.resolve(spaces('Before'));
    await changed;
    expect(listCanvases).toHaveBeenCalledTimes(2);
    expect(useWorkspaceStore.getState().spaceSummaries.target).toEqual({
      nodeCount: 24,
      updatedAt: 2345,
    });
  });

  it('does not restore stale counts if the post-mutation refresh fails', async () => {
    useWorkspaceStore.setState({
      spaceTitles: { target: 'Known' },
      spaceSummaries: { target: { nodeCount: 2, updatedAt: 1 } },
    });
    vi.mocked(listCanvases).mockRejectedValueOnce(new Error('Offline'));
    await useWorkspaceStore.getState().refreshSpaceTitles(['target']);
    expect(useWorkspaceStore.getState()).toMatchObject({
      spaceTitles: { target: 'Known' },
      spaceSummaries: {},
      spaceTitlesError: 'Offline',
    });
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores an old workspace request that completes with %s after switching away and back',
    async (completion) => {
      const response = deferred<ListCanvasesResponse>();
      vi.mocked(listCanvases).mockReturnValueOnce(response.promise);
      const oldRequest = useWorkspaceStore.getState().refreshSpaceTitles();
      void useWorkspaceStore.getState().refreshSpaceTitles(['target']);
      await Promise.resolve();
      await useWorkspaceStore.getState().activateRecentWorkspace(SECOND_ID);
      expect(useWorkspaceStore.getState()).toMatchObject({
        spaceTitles: {},
        spaceSummaries: {},
        spaceTitlesStatus: 'idle',
      });
      vi.mocked(listCanvases).mockResolvedValueOnce(spaces('Second workspace'));
      await useWorkspaceStore.getState().refreshSpaceTitles();
      await useWorkspaceStore.getState().activateRecentWorkspace(FIRST_ID);
      vi.mocked(listCanvases).mockResolvedValueOnce(
        spaces('Current first workspace'),
      );
      await useWorkspaceStore.getState().refreshSpaceTitles();
      if (completion === 'resolve')
        response.resolve(spaces('Stale first workspace'));
      else response.reject(new Error('Old workspace error'));
      await oldRequest;
      expect(useWorkspaceStore.getState()).toMatchObject({
        spaceTitles: { target: 'Current first workspace' },
        spaceTitlesStatus: 'ready',
        spaceTitlesError: null,
      });
    },
  );

  it('does not request metadata during workspace activation', async () => {
    useWorkspaceStore.setState({ isSyncing: true });
    await useWorkspaceStore.getState().refreshSpaceTitles();
    expect(listCanvases).not.toHaveBeenCalled();
  });

  it('keeps coalescing the new workspace request when an old request settles first', async () => {
    const oldResponse = deferred<ListCanvasesResponse>();
    const newResponse = deferred<ListCanvasesResponse>();
    vi.mocked(listCanvases)
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(newResponse.promise);
    const oldRequest = useWorkspaceStore.getState().refreshSpaceTitles();
    await Promise.resolve();
    await useWorkspaceStore.getState().activateRecentWorkspace(SECOND_ID);
    const newRequest = useWorkspaceStore.getState().refreshSpaceTitles();
    oldResponse.resolve(spaces('Stale'));
    await oldRequest;
    expect(useWorkspaceStore.getState().spaceTitlesStatus).toBe('loading');
    expect(useWorkspaceStore.getState().spaceTitles).toEqual({});
    expect(useWorkspaceStore.getState().refreshSpaceTitles()).toBe(newRequest);
    newResponse.resolve(spaces('Current'));
    await newRequest;
    expect(listCanvases).toHaveBeenCalledTimes(2);
    expect(useWorkspaceStore.getState().spaceTitles.target).toBe('Current');
  });
});

describe('workspaceStore registry persistence', () => {
  beforeEach(() => {
    apiState.info = unconfiguredInfo();
    apiState.workspaces = descriptors();
    vi.clearAllMocks();
    useWorkspaceStore.setState({
      mode: null,
      capabilities: null,
      workspacePath: null,
      workspaceId: null,
      workspaceName: null,
      worldCanvasId: null,
      recentWorkspaces: [],
      isReady: false,
      isSyncing: false,
      error: null,
      canvasCount: null,
      spaceTitles: {},
      spaceTitlesStatus: 'idle',
      spaceTitlesError: null,
    });
  });

  it('restores the first Workspace from server-owned MRU order', async () => {
    await expect(useWorkspaceStore.getState().init()).resolves.toBe(true);

    expect(apiMocks.activateWorkspace).toHaveBeenCalledWith(SECOND_ID);
    expect(useWorkspaceStore.getState()).toMatchObject({
      workspaceId: SECOND_ID,
      workspacePath: '/tmp/second',
      workspaceName: 'Second',
      isReady: true,
      isSyncing: false,
    });
    expect(
      useWorkspaceStore
        .getState()
        .recentWorkspaces.map((workspace) => workspace.workspaceId),
    ).toEqual([SECOND_ID, FIRST_ID]);
  });

  it('keeps an already-activated Workspace when the registry cannot be listed', async () => {
    apiState.info = {
      ...unconfiguredInfo(),
      configured: true,
      workspaceId: FIRST_ID,
      path: '/tmp/first',
      name: 'First',
    };
    apiMocks.listWorkspaces.mockRejectedValueOnce(new Error('registry broken'));

    await expect(useWorkspaceStore.getState().init()).resolves.toBe(true);

    // Only the welcome list degrades — the Server is activated and usable.
    expect(apiMocks.activateWorkspace).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState()).toMatchObject({
      workspaceId: FIRST_ID,
      isReady: true,
      isSyncing: false,
      error: null,
      recentWorkspaces: [],
    });
  });

  it('shares concurrent initialization so the MRU Workspace activates once', async () => {
    const first = useWorkspaceStore.getState().init();
    const second = useWorkspaceStore.getState().init();

    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(apiMocks.activateWorkspace).toHaveBeenCalledTimes(1);
  });

  it('unregisters a recent Workspace through the plural API', async () => {
    useWorkspaceStore.setState({ recentWorkspaces: descriptors() });

    useWorkspaceStore.getState().removeRecentWorkspace(FIRST_ID);
    await vi.waitFor(() => {
      expect(useWorkspaceStore.getState().recentWorkspaces).toHaveLength(1);
    });

    expect(apiMocks.removeWorkspace).toHaveBeenCalledWith(FIRST_ID);
    expect(useWorkspaceStore.getState().recentWorkspaces[0]?.workspaceId).toBe(
      SECOND_ID,
    );
  });
});
