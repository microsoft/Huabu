// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceInfo } from '../api/workspace';

const api = vi.hoisted(() => ({
  getWorkspaceInfo: vi.fn(),
  putWorkspacePath: vi.fn(),
  listCanvases: vi.fn(),
}));

const environment = vi.hoisted(() => ({
  bridge: null as null | {
    workspace: {
      get: () => Promise<{ path: string | null; recent: string[] }>;
      set: (path: string) => Promise<{ path: string | null; recent: string[] }>;
      removeRecent: (
        path: string,
      ) => Promise<{ path: string | null; recent: string[] }>;
    };
  },
}));

vi.mock('../api/workspace', () => ({
  getWorkspaceInfo: api.getWorkspaceInfo,
  putWorkspacePath: api.putWorkspacePath,
}));

vi.mock('../api/canvas', () => ({
  listCanvases: api.listCanvases,
}));

vi.mock('../hooks/useElectron', () => ({
  getElectronBridge: () => environment.bridge,
}));

const ACTIVE_PATH = '/tmp/huabu-workspace-active';
const PENDING_PATH = '/tmp/huabu-workspace-pending';

function workspaceInfo(overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    mode: 'free',
    configured: true,
    path: ACTIVE_PATH,
    name: 'huabu-workspace-active',
    worldCanvasId: 'world-id',
    startupError: null,
    capabilities: {
      canChangeWorkspace: true,
      nativePicker: false,
    },
    ...overrides,
  };
}

async function loadStore() {
  return (await import('./workspaceStore')).useWorkspaceStore;
}

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  localStorage.clear();
  environment.bridge = null;
  api.getWorkspaceInfo.mockReset();
  api.putWorkspacePath.mockReset();
  api.listCanvases.mockReset().mockResolvedValue({ canvases: [] });
});

describe('workspace persistence across process restarts', () => {
  it('preserves a pending path when the current server still serves the old one', async () => {
    localStorage.setItem('huabu:workspace-path', PENDING_PATH);
    localStorage.setItem(
      'huabu:recent-workspaces',
      JSON.stringify([PENDING_PATH, ACTIVE_PATH]),
    );
    api.getWorkspaceInfo.mockResolvedValue(workspaceInfo());
    const store = await loadStore();

    await expect(store.getState().init()).resolves.toBe(true);

    expect(localStorage.getItem('huabu:workspace-path')).toBe(PENDING_PATH);
    expect(store.getState()).toMatchObject({
      workspacePath: ACTIVE_PATH,
      pendingWorkspacePath: PENDING_PATH,
      isReady: true,
      isSyncing: false,
    });
  });

  it('coalesces concurrent initialization into one server request', async () => {
    let resolveInfo!: (info: WorkspaceInfo) => void;
    api.getWorkspaceInfo.mockImplementation(
      () =>
        new Promise<WorkspaceInfo>((resolve) => {
          resolveInfo = resolve;
        }),
    );
    const store = await loadStore();

    const first = store.getState().init();
    const second = store.getState().init();
    await Promise.resolve();
    await Promise.resolve();
    resolveInfo(workspaceInfo());

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(api.getWorkspaceInfo).toHaveBeenCalledTimes(1);
  });

  it('clears the syncing state when saving a restart choice fails', async () => {
    environment.bridge = {
      workspace: {
        get: vi.fn().mockResolvedValue({ path: ACTIVE_PATH, recent: [] }),
        set: vi.fn().mockRejectedValue(new Error('Storage quota full')),
        removeRecent: vi
          .fn()
          .mockResolvedValue({ path: ACTIVE_PATH, recent: [] }),
      },
    };
    const store = await loadStore();
    const { ApiError } = await import('../api/_client');
    api.putWorkspacePath.mockRejectedValue(
      new ApiError(
        409,
        {
          code: 'WORKSPACE_RESTART_REQUIRED',
          message: 'Restart required',
        },
        'Restart required',
      ),
    );
    store.setState({
      mode: 'free',
      isReady: true,
      workspacePath: ACTIVE_PATH,
    });

    await expect(
      store.getState().selectWorkspace(PENDING_PATH),
    ).rejects.toThrow('Storage quota full');

    expect(store.getState()).toMatchObject({
      isSyncing: false,
      pendingWorkspacePath: null,
    });
    expect(store.getState().error).toMatch(/Storage quota full/);
  });
});
