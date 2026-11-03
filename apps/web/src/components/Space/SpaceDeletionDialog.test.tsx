// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/_client';
import {
  CanvasConflictError,
  NodeDuplicateFilesError,
  putNodeContent,
} from '@/api/canvas';
import { deleteSpaceTree, getSpaceDeletionPreview } from '@/api/spaceHierarchy';
import { toast } from '@/components/Common/Toast';
import { drainPendingSaves } from '@/store/canvasStore';
import { createNodeContentQueue } from '@/store/canvasStore/save/nodeContentQueue';
import { ConversationTitleSaveError } from '@/store/conversationTitleStore';
import { deleteWorkspace } from '@/store/previewWorkspace/persistence';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { pageLifecycle } from '@/utils/pageLifecycle';
import { saveErrorsHandledByCaller } from '@/utils/saveErrorFeedback';

import { SpaceDeletionDialog } from './SpaceDeletionDialog';

import type * as CanvasApi from '@/api/canvas';
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
vi.mock('@/api/canvas', async (importOriginal) => ({
  ...(await importOriginal<typeof CanvasApi>()),
  putNodeContent: vi.fn(),
}));
vi.mock('@/store/canvasStore', () => ({
  drainPendingSaves: vi.fn(async () => undefined),
}));
vi.mock('@/store/previewWorkspace/persistence', () => ({
  deleteWorkspace: vi.fn(),
}));
vi.mock('@/components/Common/Toast', () => ({
  toast: vi.fn(),
  dismissToast: vi.fn(),
}));
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
let unregisterSave: () => void;
const onDeleted = vi.fn();
const refresh = vi.fn(async (): Promise<void> => undefined);
const originalRefresh = useWorkspaceStore.getState().refreshSpaceTitles;

beforeEach(async () => {
  vi.clearAllMocks();
  unregisterSave = pageLifecycle.register('test-deletion-save', {
    flush: () => drainPendingSaves(),
  });
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
  unregisterSave();
  host.remove();
  useWorkspaceStore.setState({ refreshSpaceTitles: originalRefresh });
  vi.restoreAllMocks();
  vi.useRealTimers();
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
  expect(onDeleted).toHaveBeenCalledExactlyOnceWith(['parent'], undefined);
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
  });
  expect(onDeleted).toHaveBeenCalledExactlyOnceWith(
    ['parent', 'child'],
    'spaceHierarchy.deletionErrors.deletedRefresh',
    true,
  );
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(toast).not.toHaveBeenCalled();
});

it('keeps preparation failures in the existing dialog without a toast', async () => {
  desktop.enabled = true;
  desktop.command.mockResolvedValueOnce({
    ok: false,
    error: 'Could not save child',
  });
  refresh.mockRejectedValueOnce(new Error('Refresh also failed'));
  await remove();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'spaceHierarchy.deletionErrors.prepare',
  );
  expect(document.querySelector('details')?.textContent).toContain(
    'Could not save child',
  );
  expect(document.querySelector('details')?.textContent).not.toContain(
    'Refresh also failed',
  );
  expect(deleteSpaceTree).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});

it('owns Note save failures from the initial local drain before desktop preparation', async () => {
  desktop.enabled = true;
  const node = {
    id: 'note',
    type: 'note',
    position: { x: 0, y: 0 },
    data: { content: 'Unsaved note' },
  };
  const queue = createNodeContentQueue({
    delayMs: 500,
    getState: () => ({
      canvasId: 'parent',
      isLoading: false,
      nodes: [node],
      _setStateNoAutosave: vi.fn(),
      patchNodeSilent: vi.fn(),
    }),
  });
  vi.mocked(putNodeContent).mockRejectedValue(new Error('Note save offline'));
  vi.mocked(drainPendingSaves).mockImplementationOnce(async () => {
    queue.scheduleChanges('parent', [], [node]);
    await queue.flushAll();
    await queue.flushAllForSubmission('parent');
  });
  await remove();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'spaceHierarchy.deletionErrors.prepare',
  );
  expect(deleteSpaceTree).not.toHaveBeenCalled();
  expect(desktop.command).not.toHaveBeenCalled();
  expect(queue.hasUnsavedContent('parent')).toBe(true);
  expect(toast).not.toHaveBeenCalled();
});

it('ends a stalled local drain after 15 seconds without waiting for refresh or deleting on late completion', async () => {
  vi.useFakeTimers();
  desktop.enabled = true;
  let finishSave!: () => void;
  vi.mocked(drainPendingSaves).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishSave = resolve;
      }),
  );
  await remove();
  expect(saveErrorsHandledByCaller()).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(14_999));
  expect(document.querySelector('[role="status"]')).not.toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(document.querySelector('[role="status"]')).toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'spaceHierarchy.deletionErrors.prepare',
  );
  expect(document.querySelector('details')?.textContent).toContain(
    'spaceHierarchy.deletionErrors.prepareTimeout',
  );
  expect(
    [...document.querySelectorAll('button')].every(
      (button) => !button.disabled,
    ),
  ).toBe(true);
  expect(refresh).not.toHaveBeenCalled();
  expect(saveErrorsHandledByCaller()).toBe(false);
  await act(async () => finishSave());
  expect(deleteSpaceTree).not.toHaveBeenCalled();
  expect(desktop.command).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});

it('uses the shared preparation to settle editors and await imports before saving', async () => {
  const settle = vi.fn();
  const unregisterEditor = pageLifecycle.register('test-editor', { settle });
  let completeImport!: () => void;
  const importing = pageLifecycle.run(
    'importing',
    () =>
      new Promise<void>((resolve) => {
        completeImport = resolve;
      }),
  );
  vi.mocked(deleteSpaceTree).mockResolvedValue({
    deletedCanvasIds: ['parent', 'child'],
  });
  try {
    await remove();
    expect(settle).toHaveBeenCalledOnce();
    expect(drainPendingSaves).not.toHaveBeenCalled();
    expect(deleteSpaceTree).not.toHaveBeenCalled();
    await act(async () => completeImport());
    await importing;
    expect(drainPendingSaves).toHaveBeenCalledOnce();
    expect(deleteSpaceTree).toHaveBeenCalledOnce();
  } finally {
    unregisterEditor();
  }
});

it('unmounting during preparation releases feedback and does not delete after saving finishes', async () => {
  let completeSave!: () => void;
  vi.mocked(drainPendingSaves).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        completeSave = resolve;
      }),
  );
  await remove();
  expect(saveErrorsHandledByCaller()).toBe(true);
  await act(async () => root.render(null));
  expect(saveErrorsHandledByCaller()).toBe(false);
  await act(async () => completeSave());
  expect(deleteSpaceTree).not.toHaveBeenCalled();
  expect(desktop.command).not.toHaveBeenCalled();
});

it('retries a retained title failure through the same local preparation', async () => {
  const error = new ConversationTitleSaveError('Title failed');
  const retry = vi.spyOn(error, 'retry').mockResolvedValue();
  vi.mocked(drainPendingSaves).mockRejectedValueOnce(error);
  vi.mocked(deleteSpaceTree).mockResolvedValue({
    deletedCanvasIds: ['parent', 'child'],
  });
  await remove();
  expect(deleteSpaceTree).not.toHaveBeenCalled();
  const recheck = [...document.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('spaceHierarchy.recheckDeletion'),
  );
  if (!recheck) throw new Error('Missing recheck action');
  await act(async () => recheck.click());
  await remove();
  expect(retry).toHaveBeenCalledOnce();
  expect(deleteSpaceTree).toHaveBeenCalledOnce();
  expect(toast).not.toHaveBeenCalled();
});

it.each([
  new CanvasConflictError({
    code: 'NODE_CONTENT_CONFLICT',
    message: 'changed elsewhere',
    currentRev: 'server-rev',
  }),
  new NodeDuplicateFilesError({
    message: 'duplicate files',
    duplicateFiles: ['a.md', 'b.md'],
  }),
])(
  'defers Note recovery until the deletion dialog closes: %s',
  async (error) => {
    const node = {
      id: 'note',
      type: 'note',
      position: { x: 0, y: 0 },
      data: { content: 'Unsaved note' },
    };
    const patchNodeSilent = vi.fn();
    const queue = createNodeContentQueue({
      delayMs: 500,
      getState: () => ({
        canvasId: 'parent',
        isLoading: false,
        nodes: [node],
        _setStateNoAutosave: vi.fn(),
        patchNodeSilent,
      }),
    });
    vi.mocked(putNodeContent).mockRejectedValue(error);
    vi.mocked(drainPendingSaves).mockImplementationOnce(async () => {
      queue.scheduleChanges('parent', [], [node]);
      await queue.flushAllForSubmission('parent');
    });
    await remove();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'spaceHierarchy.deletionErrors.prepare',
    );
    expect(deleteSpaceTree).not.toHaveBeenCalled();
    expect(queue.hasUnsavedContent('parent')).toBe(true);
    expect(node.data.content).toBe('Unsaved note');
    expect(toast).not.toHaveBeenCalled();
    if (error instanceof NodeDuplicateFilesError) {
      expect(patchNodeSilent).toHaveBeenCalledWith('note', {
        contentDuplicate: true,
        duplicateFiles: ['a.md', 'b.md'],
      });
    } else {
      await queue.flushNow('parent', 'note');
      expect(putNodeContent).toHaveBeenCalledOnce();
    }
    await act(async () => root.render(null));
    expect(toast).toHaveBeenCalledOnce();
    if (error instanceof CanvasConflictError) {
      const options = vi.mocked(toast).mock.calls[0][1];
      expect(options?.action?.onClick).toBeTypeOf('function');
      vi.mocked(putNodeContent).mockResolvedValue({
        nodeId: 'note',
        label: null,
        rev: 'saved',
      });
      options?.secondaryAction?.onClick();
      await vi.waitFor(() => {
        expect(queue.hasUnsavedContent('parent')).toBe(false);
      });
      expect(vi.mocked(putNodeContent).mock.calls[1][2]).toMatchObject({
        content: 'Unsaved note',
        expectRev: 'server-rev',
      });
    }
    queue.discardCanvas('parent');
  },
);

it.each(['parent', 'unrelated'])(
  'refuses deletion when the live preview is not a child of its container: %s',
  async (containerSpaceId) => {
    await act(async () =>
      root.render(
        <SpaceDeletionDialog
          canvasId="parent"
          containerSpaceId={containerSpaceId}
          onClose={vi.fn()}
          onDeleted={onDeleted}
        />,
      ),
    );
    await remove();
    expect(deleteSpaceTree).not.toHaveBeenCalled();
    expect(drainPendingSaves).not.toHaveBeenCalled();
    expect(document.querySelector('details')?.textContent).toContain(
      'spaceHierarchy.deleteFromContainer',
    );
  },
);

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
