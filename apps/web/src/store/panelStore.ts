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

  /** When > 0, the right panel should be open. Incremented to trigger re-open. */
  rightPanelOpenRequest: number;
  /** Request the right (chat) panel to open. */
  requestOpenRightPanel: () => void;
}

export const usePanelStore = create<PanelState>()((set) => ({
  isLeftCollapsed: true,
  setLeftCollapsed: (collapsed) => set({ isLeftCollapsed: collapsed }),
  toggleLeftPanel: () => set((s) => ({ isLeftCollapsed: !s.isLeftCollapsed })),

  rightPanelOpenRequest: 0,
  requestOpenRightPanel: () =>
    set((s) => ({ rightPanelOpenRequest: s.rightPanelOpenRequest + 1 })),
}));
