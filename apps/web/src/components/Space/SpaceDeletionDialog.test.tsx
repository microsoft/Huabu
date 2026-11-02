// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/_client';
import { deleteSpaceTree, getSpaceDeletionPreview } from '@/api/spaceHierarchy';
import { toast } from '@/components/Common/Toast';
import { deleteWorkspace } from '@/store/previewWorkspace/persistence';
import { useWorkspaceStore } from '@/store/workspaceStore';

import { SpaceDeletionDialog } from './SpaceDeletionDialog';

import type * as Electron from '@/hooks/useElectron';

const desktop = vi.hoisted(() => ({ enabled: false, command: vi.fn() }));
vi.mock('@/hooks/useElectron', async (importOriginal) => ({
  ...(await importOriginal<typeof Electron>()),
  getElectronBridge: () =>
    desktop.enabled ? { tabs: { command: desktop.command } } : undefined,
}));
vi.mock('@/api/spaceHierarchy', () => ({
  deleteSpaceTree: vi.fn(),
  getSpaceDeletionPreview: vi.fn(),
}));
vi.mock('@/store/canvasStore', () => ({
  drainPendingSaves: vi.fn(async () => undefined),
}));
vi.mock('@/store/previewWorkspace/persistence', () => ({
  deleteWorkspace: vi.fn(),
}));
vi.mock('@/components/Common/Toast', () => ({ toast: vi.fn() }));
vi.mock('@/components/Common/Loading', () => ({ Loading: () => null }));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: translate }),
}));
const translate = (key: string, values?: Record<string, unknown>) =>
  values ? `${key} ${JSON.stringify(values)}` : key;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const onDeleted = vi.fn();
const refresh = vi.fn(async (): Promise<void> => undefined);
const originalRefresh = useWorkspaceStore.getState().refreshSpaceTitles;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  desktop.enabled = false;
  desktop.command.mockReset().mockResolvedValue({ ok: true });
  useWorkspaceStore.setState({
    workspaceId: 'workspace',
    refreshSpaceTitles: refresh,
  });
  vi.mocked(getSpaceDeletionPreview).mockResolvedValue({
    token: 'token',
    spaces: [
      { canvasId: 'parent', title: 'Parent', parentSpaceId: 'grandparent' },
      { canvasId: 'child', title: 'Child', parentSpaceId: 'parent' },
    ],
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <SpaceDeletionDialog
        canvasId="parent"
        onClose={vi.fn()}
        onDeleted={onDeleted}
      />,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useWorkspaceStore.setState({ refreshSpaceTitles: originalRefresh });
  vi.restoreAllMocks();
});

async function remove() {
  const button = [...document.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('spaceHierarchy.deleteCount'),
  );
  if (!button) throw new Error('Missing delete action');
  await act(async () => button.click());
}

it('names the target only in the title and summarizes descendant deletion', () => {
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.querySelector('h3')?.textContent).toBe(
    'spaceHierarchy.deleteNamedTitle {"name":"Parent"}',
  );
  expect(dialog?.textContent?.match(/Parent/g)).toHaveLength(1);
  expect(dialog?.textContent).toContain(
    'spaceHierarchy.deleteDescendants {"count":1}',
  );
  expect(dialog?.textContent).toContain(
    'spaceHierarchy.deleteCount {"count":2}',
  );
  expect(dialog?.querySelector('ul')).toBeNull();
  expect(dialog?.textContent).not.toContain('spaceHierarchy.linkedSpacesKept');
});

it('shows no descendant summary for an untitled Space without children', async () => {
  vi.mocked(getSpaceDeletionPreview).mockResolvedValueOnce({
    token: 'leaf-token',
    spaces: [{ canvasId: 'leaf', title: null, parentSpaceId: null }],
  });
  await act(async () =>
    root.render(
      <SpaceDeletionDialog
        canvasId="leaf"
        onClose={vi.fn()}
        onDeleted={onDeleted}
      />,
    ),
  );
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.querySelector('h3')?.textContent).toBe(
    'spaceHierarchy.deleteNamedTitle {"name":"canvasList.untitled"}',
  );
  expect(dialog?.textContent).not.toContain('spaceHierarchy.deleteDescendants');
  expect(dialog?.textContent).toContain(
    'spaceHierarchy.deleteCount {"count":1}',
  );
});

it.each([['child'], ['child', 'parent']])(
  'reconciles confirmed deletions without claiming success: %j',
  async (...deleted) => {
    vi.mocked(deleteSpaceTree).mockRejectedValue(
      new ApiError(
        500,
        {
          code: 'SPACE_TREE_DELETE_FAILED',
          message: 'Cleanup failed',
          details: {
            deletedCanvasIds: deleted,
            remainingCanvasIds: deleted.includes('parent') ? [] : ['parent'],
            cause: 'Failure',
          },
        },
        'Failure',
      ),
    );
    await remove();
    expect(onDeleted).toHaveBeenCalledWith(
      deleted,
      'spaceHierarchy.deletionErrors.interrupted',
      deleted.includes('parent')
        ? { child: 'grandparent', parent: 'grandparent' }
        : { child: 'parent' },
    );
    for (const id of deleted) expect(deleteWorkspace).toHaveBeenCalledWith(id);
    expect(refresh).toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'spaceHierarchy.deletionErrors.interrupted',
    );
    if (deleted.includes('parent'))
      expect(document.body.textContent).not.toContain(
        'spaceHierarchy.recheckDeletion',
      );
    expect(document.body.textContent).toContain(
      `spaceHierarchy.deletionProgress {"count":${deleted.length}}`,
    );
  },
);

it('does not reconcile malformed or unconfirmed deletion IDs', async () => {
  vi.mocked(deleteSpaceTree).mockRejectedValue(
    new ApiError(
      500,
      {
        code: 'SPACE_TREE_DELETE_FAILED',
        message: 'Cleanup failed',
        details: {
          deletedCanvasIds: ['unrelated'],
          remainingCanvasIds: [],
          cause: 'Failure',
        },
      },
      'Failure',
    ),
  );
  await remove();
  expect(onDeleted).not.toHaveBeenCalled();
  expect(deleteWorkspace).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'spaceHierarchy.deletionErrors.interrupted',
  );
});

it('does not call the old deletion callback after switching Workspace during refresh', async () => {
  vi.mocked(deleteSpaceTree).mockResolvedValue({
    deletedCanvasIds: ['parent'],
  });
  let finishRefresh!: () => void;
  refresh.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishRefresh = resolve;
      }),
  );
  await remove();
  expect(refresh).toHaveBeenCalledOnce();
  expect(onDeleted).not.toHaveBeenCalled();
  await act(async () => {
    useWorkspaceStore.setState({ workspaceId: 'another-workspace' });
    finishRefresh();
  });
  expect(onDeleted).not.toHaveBeenCalled();
});

it('notifies the parent after refresh when the Workspace is unchanged', async () => {
  vi.mocked(deleteSpaceTree).mockResolvedValue({
    deletedCanvasIds: ['parent'],
  });
  await remove();
  expect(onDeleted).toHaveBeenCalledExactlyOnceWith(['parent'], undefined, {
    parent: 'grandparent',
  });
});

it('waits for desktop preparation before deleting and reports confirmed IDs on completion', async () => {
  desktop.enabled = true;
  let prepared!: (result: { ok: true }) => void;
  desktop.command.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        prepared = resolve;
      }),
  );
  vi.mocked(deleteSpaceTree).mockResolvedValue({
    deletedCanvasIds: ['child', 'parent'],
  });
  await remove();
  expect(desktop.command).toHaveBeenCalledWith({
    type: 'begin-space-deletion',
    canvasId: 'parent',
    canvasIds: ['parent', 'child'],
  });
  expect(deleteSpaceTree).not.toHaveBeenCalled();
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.querySelector('h3')?.textContent).toBe(
    'spaceHierarchy.deletingNamedTitle {"name":"Parent"}',
  );
  expect(dialog?.querySelector('[role="status"]')?.textContent).toBe(
    'spaceHierarchy.deletionInProgress',
  );
  expect(dialog?.textContent).not.toContain('spaceHierarchy.deleteWarning');
  const buttons = [...(dialog?.querySelectorAll('button') ?? [])];
  expect(buttons.map((button) => button.textContent)).toEqual([
    'actions.cancel',
    'spaceHierarchy.deleting',
  ]);
  expect(buttons.every((button) => button.disabled)).toBe(true);
  await act(async () => prepared({ ok: true }));
  expect(deleteSpaceTree).toHaveBeenCalledExactlyOnceWith('parent', 'token');
  expect(desktop.command).toHaveBeenLastCalledWith({
    type: 'end-space-deletion',
    deletedCanvasIds: ['child', 'parent'],
    returnTo: { child: 'grandparent', parent: 'grandparent' },
  });
  expect(dialog?.textContent).not.toContain(
    'spaceHierarchy.deletionInProgress',
  );
});

it('reports partial deletion to desktop so only deleted Tabs close', async () => {
  desktop.enabled = true;
  vi.mocked(deleteSpaceTree).mockRejectedValue(
    new ApiError(
      500,
      {
        code: 'SPACE_TREE_DELETE_FAILED',
        message: 'Cleanup failed',
        details: {
          deletedCanvasIds: ['child'],
          remainingCanvasIds: ['parent'],
          cause: 'Failure',
        },
      },
      'Failure',
    ),
  );
  await remove();
  expect(desktop.command).toHaveBeenLastCalledWith({
    type: 'end-space-deletion',
    deletedCanvasIds: ['child'],
    returnTo: { child: 'parent' },
    failure: 'spaceHierarchy.deletionErrors.interrupted',
  });
});

it('still closes deleted Tabs when refreshing Space titles fails', async () => {
  desktop.enabled = true;
  vi.mocked(deleteSpaceTree).mockResolvedValue({
    deletedCanvasIds: ['parent', 'child'],
  });
  refresh.mockRejectedValueOnce(new Error('Refresh failed'));
  await remove();
  expect(desktop.command).toHaveBeenLastCalledWith({
    type: 'end-space-deletion',
    deletedCanvasIds: ['parent', 'child'],
    returnTo: { child: 'grandparent', parent: 'grandparent' },
    failure: 'spaceHierarchy.deletionErrors.refresh',
  });
  expect(toast).not.toHaveBeenCalled();
});

it('keeps preparation failures in the existing dialog without a toast', async () => {
  desktop.enabled = true;
  desktop.command.mockResolvedValueOnce({
    ok: false,
    error: 'Could not save child',
  });
  await remove();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'spaceHierarchy.deletionErrors.prepare',
  );
  expect(document.querySelector('details')?.textContent).toContain(
    'Could not save child',
  );
  expect(deleteSpaceTree).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});

it('reports release errors inline and retains the dialog after deletion', async () => {
  desktop.enabled = true;
  desktop.command.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({
    ok: false,
    error: 'Could not save Tab session',
  });
  vi.mocked(deleteSpaceTree).mockResolvedValue({
    deletedCanvasIds: ['parent', 'child'],
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await remove();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'spaceHierarchy.deletionErrors.release',
    );
    expect(onDeleted).toHaveBeenCalledWith(
      ['parent', 'child'],
      'spaceHierarchy.deletionErrors.release',
      {
        child: 'grandparent',
        parent: 'grandparent',
      },
    );
    expect(toast).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

it('retains the target and groups recovery actions without a disabled delete button', async () => {
  vi.mocked(deleteSpaceTree).mockRejectedValueOnce(
    new ApiError(
      409,
      { code: 'SPACE_AGENT_RUNNING', message: 'Stop running Agents' },
      'Failure',
    ),
  );
  await remove();
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.querySelector('h3')?.textContent).toBe(
    'spaceHierarchy.deleteFailedNamedTitle {"name":"Parent"}',
  );
  expect(dialog?.querySelector('[role="alert"]')?.textContent).toBe(
    'spaceHierarchy.deletionErrors.agentRunning',
  );
  expect(dialog?.textContent).not.toContain('Stop running Agents');
  expect(dialog?.textContent).not.toContain('spaceHierarchy.deleteWarning');
  expect(dialog?.querySelector('details')).toBeNull();
  const buttons = [...(dialog?.querySelectorAll('button') ?? [])];
  expect(buttons.map((button) => button.textContent)).toEqual([
    'actions.cancel',
    'spaceHierarchy.recheckDeletion',
  ]);
  expect(buttons[0].parentElement).toBe(buttons[1].parentElement);
  expect(toast).not.toHaveBeenCalled();

  vi.mocked(getSpaceDeletionPreview).mockResolvedValueOnce({
    token: 'updated-token',
    spaces: [{ canvasId: 'parent', title: 'Parent', parentSpaceId: null }],
  });
  await act(async () => buttons[1].click());
  expect(deleteSpaceTree).toHaveBeenCalledTimes(1);
  expect(dialog?.textContent).not.toContain('spaceHierarchy.deleteFailed');
  expect(document.activeElement).toBe(buttons[0]);
  vi.mocked(deleteSpaceTree).mockResolvedValueOnce({
    deletedCanvasIds: ['parent'],
  });
  await remove();
  expect(deleteSpaceTree).toHaveBeenLastCalledWith('parent', 'updated-token');
});

it('does not reuse the previous preview when rechecking fails', async () => {
  vi.mocked(deleteSpaceTree).mockRejectedValueOnce(new Error('Network failed'));
  await remove();
  vi.mocked(getSpaceDeletionPreview).mockRejectedValueOnce(
    new Error('Preview unavailable'),
  );
  const retry = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'spaceHierarchy.recheckDeletion',
  );
  expect(retry).toBeDefined();
  await act(async () => retry?.click());
  expect(document.querySelector('h3')?.textContent).toContain('Parent');
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    'spaceHierarchy.deletionErrors.preview',
  );
  expect(document.querySelector('details')?.textContent).toContain(
    'Preview unavailable',
  );
  expect(document.body.textContent).not.toContain('spaceHierarchy.deleteCount');
  expect(deleteSpaceTree).toHaveBeenCalledTimes(1);
});
