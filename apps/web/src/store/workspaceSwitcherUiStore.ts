// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

/**
 * Global open-state for the Switch Workspace dialog, the full chooser for
 * named Workspaces (`capabilities.namedWorkspaces`).
 *
 * Mounted once at the router root like Settings, so the header popover's
 * "All Workspaces…" and "New Workspace…", the app menu and the desktop menu
 * all open the same instance wherever the person is. Folder Workspaces keep
 * their own chooser on the first-launch page.
 */
interface WorkspaceSwitcherUiState {
  isOpen: boolean;
  /**
   * What the dialog starts on: `choose` focuses the list, `create` the new
   * Workspace name field.
   */
  intent: 'choose' | 'create';
  open: (intent?: 'choose' | 'create') => void;
  close: () => void;
  /**
   * A Workspace switch is in flight, from saving the open Space's edits until
   * the new Workspace is open or the switch fails. It is the one-at-a-time
   * lock for `useWorkspaceSwitch`; choosers disable themselves while it is
   * set.
   */
  switching: boolean;
  setSwitching: (switching: boolean) => void;
}

export const useWorkspaceSwitcherUiStore = create<WorkspaceSwitcherUiState>(
  (set) => ({
    isOpen: false,
    intent: 'choose',
    open: (intent = 'choose') => set({ isOpen: true, intent }),
    close: () => set({ isOpen: false, intent: 'choose' }),
    switching: false,
    setSwitching: (switching) => set({ switching }),
  }),
);
