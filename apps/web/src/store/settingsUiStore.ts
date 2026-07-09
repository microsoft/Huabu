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
 */
interface SettingsUiState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useSettingsUiStore = create<SettingsUiState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
