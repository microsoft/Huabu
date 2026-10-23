// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, expect, it, vi } from 'vitest';

import { placeChildSpace } from './placeChildSpace';

const mocks = vi.hoisted(() => ({
  canvas: { canvasId: 'parent' },
  workspace: { workspaceId: 'workspace', refreshSpaceTitles: vi.fn() },
  create: vi.fn(),
  drain: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/api/spaceHierarchy', () => ({ createChildSpace: mocks.create }));
vi.mock('@/components/Common/Toast', () => ({ toast: mocks.toast }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/store/canvasStore', () => ({
  default: { getState: () => mocks.canvas },
  drainPendingSaves: mocks.drain,
}));
vi.mock('@/store/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => mocks.workspace },
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.canvas.canvasId = 'parent';
  mocks.workspace.workspaceId = 'workspace';
  mocks.create.mockResolvedValue({
    canvasId: 'child',
    parentEntryNodeId: 'node-entry',
  });
});

it('creates at the placement point and keeps the current Space unchanged', async () => {
  const position = { x: -42, y: 135 };
  expect(await placeChildSpace('parent', position)).toBe('child');
  expect(mocks.drain).toHaveBeenCalledOnce();
  expect(mocks.create).toHaveBeenCalledWith('parent', {
    title: 'canvasList.untitled',
    position,
  });
  expect(mocks.drain.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.create.mock.invocationCallOrder[0],
  );
  expect(mocks.workspace.refreshSpaceTitles).toHaveBeenCalledWith([
    'parent',
    'child',
  ]);
  expect(mocks.canvas.canvasId).toBe('parent');
});

it('does not create in a stale Space after draining saves', async () => {
  mocks.drain.mockImplementation(async () => {
    mocks.canvas.canvasId = 'elsewhere';
  });
  await placeChildSpace('parent', { x: 0, y: 0 });
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith('spaceHierarchy.workspaceChanged', {
    tone: 'danger',
  });
});

it('surfaces server errors without retrying creation', async () => {
  mocks.create.mockRejectedValue(new Error('Creation failed'));
  await placeChildSpace('parent', { x: 0, y: 0 });
  expect(mocks.toast).toHaveBeenCalledWith('Creation failed', {
    tone: 'danger',
  });
  expect(mocks.create).toHaveBeenCalledOnce();
});

it('does not refresh a different Workspace after creation', async () => {
  mocks.create.mockImplementation(async () => {
    mocks.workspace.workspaceId = 'other';
    return { canvasId: 'child' };
  });
  await placeChildSpace('parent', { x: 0, y: 0 });
  expect(mocks.workspace.refreshSpaceTitles).not.toHaveBeenCalled();
});

it('does not enter a child after switching Workspace while refreshing titles', async () => {
  mocks.workspace.refreshSpaceTitles.mockImplementation(async () => {
    mocks.workspace.workspaceId = 'other';
  });
  expect(await placeChildSpace('parent', { x: 0, y: 0 })).toBeUndefined();
});
