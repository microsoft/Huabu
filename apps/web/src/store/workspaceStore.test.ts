// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useWorkspaceStore } from './workspaceStore';

import type { WorkspaceDescriptor, WorkspaceInfo } from '../api/workspace';

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
