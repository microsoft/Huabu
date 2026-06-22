import { create } from 'zustand';

interface PanelState {
  /**
   * Collapse state for the left (layer) side panel.
   *
   * Hoisted out of `MainLayout`'s local `useState` so subtrees inside
   * the column (notably `CanvasLayerPanel`) can read it and skip
   * expensive work while the column animates to 0 — `MainLayout` keeps
   * the subtree mounted on purpose so its 220ms width animation runs
   * without a content-swap flash.
   */
  isLeftCollapsed: boolean;
  setLeftCollapsed: (collapsed: boolean) => void;
  toggleLeftPanel: () => void;

  /**
   * Whether the canvas-wide search input is revealed in the left
   * layer panel. Default `false` so the panel chrome stays quiet
   * for users who never search; flipped to `true` by the search
   * icon in `LayerFilterBar`, by `Cmd+F`, or by any other entry
   * point that needs the input focused. Lives in this global store
   * because the toggle is driven from multiple, non-adjacent
   * surfaces (toolbar button, hotkey, future API), and the
   * `CanvasSearchInput` component is mounted only while this is
   * `true` so its auto-focus / cleanup run on every reveal.
   */
  isSearchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  toggleSearchOpen: () => void;

  /** When > 0, the right panel should be open. Incremented to trigger re-open. */
  rightPanelOpenRequest: number;
  /** Request the right (chat) panel to open. */
  requestOpenRightPanel: () => void;
}

export const usePanelStore = create<PanelState>()((set) => ({
  isLeftCollapsed: true,
  setLeftCollapsed: (collapsed) => set({ isLeftCollapsed: collapsed }),
  toggleLeftPanel: () => set((s) => ({ isLeftCollapsed: !s.isLeftCollapsed })),

  isSearchOpen: false,
  setSearchOpen: (open) => set({ isSearchOpen: open }),
  toggleSearchOpen: () => set((s) => ({ isSearchOpen: !s.isSearchOpen })),

  rightPanelOpenRequest: 0,
  requestOpenRightPanel: () =>
    set((s) => ({ rightPanelOpenRequest: s.rightPanelOpenRequest + 1 })),
}));
