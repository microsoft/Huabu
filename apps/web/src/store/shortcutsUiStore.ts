// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

/**
 * Global open-state for the {@link KeyboardShortcutsModal}.
 *
 * Previously owned locally by `CanvasPage` via `usePageShortcuts`, which
 * meant the help modal only existed inside a canvas. Lifting it into a
 * store lets the canvas menu, the title-bar `AppMenu`, and the global
 * `?` hotkey all drive one modal instance (mounted once at the router
 * root) so it is reachable from the canvas list page too.
 */
interface ShortcutsUiState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

export const useShortcutsUiStore = create<ShortcutsUiState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
}));
