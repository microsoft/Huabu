// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Navigate } from 'react-router-dom';

import { getElectronBridge } from '../../hooks/useElectron';
import { useWorkspaceStore } from '../../store/workspaceStore';

/**
 * The `/` route: where the current Workspace opens. That is its World when
 * World is on (outside desktop Home, which always lists Spaces), and the
 * Spaces page otherwise. It resolves against whichever Workspace is current
 * when it renders, so a Workspace switch reaches it only after activation.
 */
export function WorkspaceLanding() {
  const desktopHome = getElectronBridge()?.tabs?.context.role === 'home';
  const worldEnabled = useWorkspaceStore((state) => state.worldEnabled);
  const worldCanvasId = useWorkspaceStore((state) => state.worldCanvasId);
  return !desktopHome && worldEnabled && worldCanvasId ? (
    <Navigate to={`/canvas/${worldCanvasId}`} replace />
  ) : (
    <Navigate to="/spaces" replace />
  );
}
