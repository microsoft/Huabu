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
const translate = (key: string) => key;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const onDeleted = vi.fn();
const refresh = vi.fn(async (): Promise<void> => undefined);
const originalRefresh = useWorkspaceStore.getState().refreshSpaceTitles;

beforeEach(async () => {
  vi.clearAllMocks();
  useWorkspaceStore.setState({
    workspaceId: 'workspace',
    refreshSpaceTitles: refresh,
  });
  vi.mocked(getSpaceDeletionPreview).mockResolvedValue({
    token: 'token',
    spaces: [
      { canvasId: 'parent', title: 'Parent' },
      { canvasId: 'child', title: 'Child' },
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
});

async function remove() {
  const button = [...document.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('spaceHierarchy.deleteCount'),
  );
  if (!button) throw new Error('Missing delete action');
  await act(async () => button.click());
}

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
    expect(onDeleted).toHaveBeenCalledWith(deleted, 'Cleanup failed');
    for (const id of deleted) expect(deleteWorkspace).toHaveBeenCalledWith(id);
    expect(refresh).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('Cleanup failed', { tone: 'danger' });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Cleanup failed',
    );
    if (deleted.includes('parent'))
      expect(document.body.textContent).not.toContain('spacePreview.retry');
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
    'Cleanup failed',
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
  expect(onDeleted).toHaveBeenCalledExactlyOnceWith(['parent']);
});
