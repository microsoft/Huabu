// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { getElectronBridge } from '../../hooks/useElectron';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { useWorkspaceSwitcherUiStore } from '../../store/workspaceSwitcherUiStore';

/**
 * Location state that asks the Home view to open the Switch Workspace dialog.
 * A desktop Space tab cannot change Workspace itself (Home does it, closing
 * every Space tab), so it forwards the request to Home with this state.
 */
export const OPEN_WORKSPACE_SWITCHER = 'huabu.openWorkspaceSwitcher';

/**
 * Open the chooser behind every "Switch Workspace" entry point: the Switch
 * Workspace dialog for named Workspaces, or, for folder Workspaces (Disk
 * "Home folder" mode), the first-launch folder chooser as before.
 */
export function useOpenWorkspaceSwitcher(): (
  intent?: 'choose' | 'create',
) => void {
  const navigate = useNavigate();
  const named = useWorkspaceStore(
    (s) => s.capabilities?.namedWorkspaces === true,
  );
  return useCallback(
    (intent = 'choose') => {
      if (!named) {
        navigate('/setup');
        return;
      }
      if (getElectronBridge()?.tabs?.context.role === 'space') {
        navigate('/spaces', { state: { [OPEN_WORKSPACE_SWITCHER]: intent } });
        return;
      }
      useWorkspaceSwitcherUiStore.getState().open(intent);
    },
    [named, navigate],
  );
}
