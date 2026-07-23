import { create } from 'zustand';

interface NodeCollapseState {
  /**
   * Canvas-space clip radius per node that is currently collapsed to its
   * zoom-LOD mark (a centred circle) — e.g. a question node in the `avatar` or
   * `dot` stage. Absent means the node is not collapsed and edges should
   * connect to its normal footprint.
   *
   * Published by {@link NodeTakeoverLayer} and read by edges
   * ({@link LabelledEdge}) so an edge terminates on the visible mark circle
   * instead of the (now-hidden) card rectangle it used to reach. The radius is
   * expressed in canvas space and is zoom-independent (the mark fills the
   * node's shorter side), so an edge only re-renders when a node's collapse
   * state actually flips, not on every zoom frame.
   */
  radii: Record<string, number>;
  setRadius: (id: string, radius: number | null) => void;
}

export const useNodeCollapseStore = create<NodeCollapseState>((set) => ({
  radii: {},
  setRadius: (id, radius) =>
    set((state) => {
      const current = state.radii[id];
      if (radius === null) {
        if (current === undefined) return state;
        const next = { ...state.radii };
        delete next[id];
        return { radii: next };
      }
      if (current === radius) return state;
      return { radii: { ...state.radii, [id]: radius } };
    }),
}));
