// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useLayoutEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { i18n } from '@/i18n';

import { drainPendingSaves } from '../../store/canvasStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { useWorkspaceSwitcherUiStore } from '../../store/workspaceSwitcherUiStore';
import { dismissToast, toast } from '../Common/Toast';

import type { NavigateFunction } from 'react-router-dom';

/** The toast that announced the last switch; a newer switch replaces it. */
let switchedToastId: string | null = null;

/**
 * The router root's current route, kept by {@link useWorkspaceSwitchRoute}.
 * Every switch reads it when it starts, so one begun from a toast that
 * outlived its chooser still sees the Space the person has open now. `null`
 * until the router root mounts.
 */
let route: { pathname: string; navigate: NavigateFunction } | null = null;

/**
 * Keep the route every Workspace switch acts on current. Mount exactly once,
 * at the never-unmounting router root (the Switch Workspace dialog's host in
 * `GlobalModals` does).
 */
export function useWorkspaceSwitchRoute(): void {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  useLayoutEffect(() => {
    route = { pathname, navigate };
  }, [pathname, navigate]);
}

/**
 * Change the signed-in person's current Workspace from inside the app, and
 * say so.
 *
 * - One switch at a time: the switcher's `switching` flag is taken before
 *   anything is awaited and held until the switch ends, so a second request
 *   made while a Space's edits are still saving is refused rather than racing
 *   the first. Choosers disable themselves while it is held.
 * - An open Space belongs to the Workspace being left, so its edits are saved
 *   first and the view moves to the new Workspace's home; no Space of the old
 *   Workspace stays on screen. If the edits cannot be saved, nothing changes.
 * - The header shows the new name as soon as the switch lands, and a toast
 *   names it with a button back to the previous Workspace, which is itself a
 *   switch like any other.
 * - Failures leave the person where they were, with the store's error.
 *
 * Returns whether the switch happened.
 */
async function switchWorkspace(
  change: () => Promise<void>,
): Promise<boolean> {
  const t = i18n.t.bind(i18n);
  const before = useWorkspaceStore.getState();
  const switcher = useWorkspaceSwitcherUiStore.getState();
  if (before.isSyncing || switcher.switching) return false;
  switcher.setSwitching(true);
  try {
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
    const inSpace = route?.pathname.startsWith('/canvas/') ?? false;
    if (inSpace) {
      try {
        await drainPendingSaves();
      } catch (error) {
        console.error('[workspace-switch] Space edits were not saved:', error);
        toast(t('workspace.unsavedBeforeSwitch'), { tone: 'danger' });
        return false;
      }
    }
    try {
      // Leave the old Workspace's Space before it stops being reachable.
      // Its edits are saved, so the navigation guard lets this through.
      if (inSpace) route?.navigate('/');
      await change();
    } catch (error) {
      console.error('[workspace-switch] Could not open Workspace:', error);
      toast(
        useWorkspaceStore.getState().error ?? t('workspace.switchFailed'),
        { tone: 'danger' },
      );
      return false;
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
                  void switchWorkspace(() =>
                    useWorkspaceStore
                      .getState()
                      .activateRecentWorkspace(previous.workspaceId),
                  ),
              }
            : undefined,
      },
    );
    return true;
  } finally {
    useWorkspaceSwitcherUiStore.getState().setSwitching(false);
  }
}

/**
 * The Workspace switch actions for a chooser, and whether a switch is in
 * flight (`busy`). See {@link switchWorkspace} for what a switch does.
 */
export function useWorkspaceSwitch() {
  const busy = useWorkspaceSwitcherUiStore((s) => s.switching);
  const actions = useMemo(
    () => ({
      switchTo: (workspaceId: string) =>
        switchWorkspace(() =>
          useWorkspaceStore.getState().activateRecentWorkspace(workspaceId),
        ),
      create: (name: string) =>
        switchWorkspace(() =>
          useWorkspaceStore.getState().createWorkspace(name),
        ),
      openFolder: (path: string) =>
        switchWorkspace(() =>
          useWorkspaceStore.getState().openFolderWorkspace(path),
        ),
    }),
    [],
  );
  return { busy, ...actions };
}
