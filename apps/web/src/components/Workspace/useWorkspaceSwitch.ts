// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import { drainPendingSaves } from '../../store/canvasStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { dismissToast, toast } from '../Common/Toast';

/** The toast that announced the last switch; a newer switch replaces it. */
let switchedToastId: string | null = null;

/**
 * Change the signed-in person's current Workspace from inside the app, and
 * say so.
 *
 * - An open Space belongs to the Workspace being left, so its edits are saved
 *   first and the view moves to the new Workspace's home; no Space of the old
 *   Workspace stays on screen. If the edits cannot be saved, nothing changes.
 * - The header shows the new name as soon as the switch lands, and a toast
 *   names it with a button back to the previous Workspace.
 * - Failures leave the person where they were, with the store's error.
 *
 * Returns whether the switch happened.
 */
export function useWorkspaceSwitch() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const pathname = useRef(location.pathname);
  pathname.current = location.pathname;
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (change: () => Promise<void>): Promise<boolean> => {
      const before = useWorkspaceStore.getState();
      if (before.isSyncing) return false;
      const previous = before.workspaceId
        ? {
            workspaceId: before.workspaceId,
            name:
              before.workspaceName ??
              before.recentWorkspaces.find(
                (workspace) => workspace.workspaceId === before.workspaceId,
              )?.name ??
              null,
          }
        : null;
      const inSpace = pathname.current.startsWith('/canvas/');
      if (inSpace) {
        try {
          await drainPendingSaves();
        } catch (error) {
          console.error(
            '[workspace-switch] Space edits were not saved:',
            error,
          );
          toast(t('workspace.unsavedBeforeSwitch'), { tone: 'danger' });
          return false;
        }
      }
      setBusy(true);
      try {
        // Leave the old Workspace's Space before it stops being reachable.
        // Its edits are saved, so the navigation guard lets this through.
        if (inSpace) navigate('/');
        await change();
      } catch (error) {
        console.error('[workspace-switch] Could not open Workspace:', error);
        toast(
          useWorkspaceStore.getState().error ?? t('workspace.switchFailed'),
          { tone: 'danger' },
        );
        return false;
      } finally {
        setBusy(false);
      }

      const after = useWorkspaceStore.getState();
      const current = after.recentWorkspaces.find(
        (workspace) => workspace.workspaceId === after.workspaceId,
      );
      const name = after.workspaceName ?? current?.name ?? '';
      if (switchedToastId) dismissToast(switchedToastId);
      switchedToastId = toast(
        current?.spaceCount === undefined
          ? t('workspace.switched', { workspace: name })
          : t('workspace.switchedCount', {
              workspace: name,
              count: current.spaceCount,
            }),
        {
          tone: 'success',
          duration: 6_000,
          action:
            previous && previous.workspaceId !== after.workspaceId
              ? {
                  label: previous.name
                    ? t('workspace.backTo', { workspace: previous.name })
                    : t('workspace.back'),
                  onClick: () =>
                    void run(() =>
                      useWorkspaceStore
                        .getState()
                        .activateRecentWorkspace(previous.workspaceId),
                    ),
                }
              : undefined,
        },
      );
      return true;
    },
    [navigate, t],
  );

  const switchTo = useCallback(
    (workspaceId: string) =>
      run(() =>
        useWorkspaceStore.getState().activateRecentWorkspace(workspaceId),
      ),
    [run],
  );
  const create = useCallback(
    (name: string) =>
      run(() => useWorkspaceStore.getState().createWorkspace(name)),
    [run],
  );
  const openFolder = useCallback(
    (path: string) =>
      run(() => useWorkspaceStore.getState().openFolderWorkspace(path)),
    [run],
  );

  return { busy, switchTo, create, openFolder };
}
