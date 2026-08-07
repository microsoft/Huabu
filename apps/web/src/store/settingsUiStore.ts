// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

/**
 * Global open-state for the tabbed {@link SettingsModal}.
 *
 * The modal used to be owned locally by each `SettingsPopover` gear
 * button (one `useState` + one `<SettingsModal>` per call site). Lifting
 * the flag into a store lets any surface — the title-bar gear, the
 * floating canvas gear, and the new `AppMenu` "Settings" item — open the
 * *same* single modal instance (mounted once at the router root) without
 * re-implementing the open/close wiring.
 *
 * `open(tab)` optionally deep-links to a specific tab so a caller far
 * from Settings (e.g. the chat "Add agent" row) can send the user
 * straight to the right pane. `requestedTab` is consumed by the modal on
 * open and then cleared so a later plain `open()` reopens on the last
 * tab the user was viewing rather than snapping back.
 */
export type SettingsTabId = 'general' | 'huabuAgent' | 'agents';

interface SettingsUiState {
  isOpen: boolean;
  /** Tab to focus on the next open, or `null` to keep the current tab. */
  requestedTab: SettingsTabId | null;
  open: (tab?: SettingsTabId) => void;
  close: () => void;
  /** Called by the modal once it has applied {@link requestedTab}. */
  clearRequestedTab: () => void;
}

export const useSettingsUiStore = create<SettingsUiState>((set) => ({
  isOpen: false,
  requestedTab: null,
  open: (tab) => set({ isOpen: true, requestedTab: tab ?? null }),
  close: () => set({ isOpen: false, requestedTab: null }),
  clearRequestedTab: () => set({ requestedTab: null }),
}));
