import { create } from 'zustand';

interface PanelState {
  /** When > 0, the right panel should be open. Incremented to trigger re-open. */
  rightPanelOpenRequest: number;
  /** Request the right (chat) panel to open. */
  requestOpenRightPanel: () => void;
}

export const usePanelStore = create<PanelState>()((set) => ({
  rightPanelOpenRequest: 0,
  requestOpenRightPanel: () =>
    set((s) => ({ rightPanelOpenRequest: s.rightPanelOpenRequest + 1 })),
}));
