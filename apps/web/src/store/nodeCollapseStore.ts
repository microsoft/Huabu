import { create } from 'zustand';

/**
 * Canvas-space geometry of a node's zoom-LOD collapsed mark — the live centre
 * and clip radius of the circle its edges should terminate on while the node
 * is collapsed to its takeover mark.
 *
 * Both centre and radius are CONTINUOUS functions of zoom: across the takeover
 * band the mark glides corner → centre and resizes, so an edge follows the mark
 * EXACTLY at every zoom instead of snapping to the node centre the moment the
 * card hides. This means an edge touching a collapsing node re-renders each
 * zoom frame while it is collapsed — the necessary cost of staying attached to
 * the moving mark.
 */
export interface CollapsedMarkGeometry {
  /** Canvas-space centre of the mark this frame. */
  cx: number;
  cy: number;
  /** Canvas-space clip radius of the mark this frame. */
  radius: number;
}

interface NodeCollapseState {
  /**
   * Per-node collapsed-mark geometry, keyed by node id. Absent means the node
   * is not collapsed and edges should connect to its normal footprint.
   *
   * Published by {@link NodeTakeoverLayer} and read by edges
   * ({@link LabelledEdge}) so an edge terminates on the visible mark circle
   * instead of the (now-hidden) card rectangle it used to reach.
   */
  marks: Record<string, CollapsedMarkGeometry>;
  setMark: (id: string, geometry: CollapsedMarkGeometry | null) => void;
}

export const useNodeCollapseStore = create<NodeCollapseState>((set) => ({
  marks: {},
  setMark: (id, geometry) =>
    set((state) => {
      const current = state.marks[id];
      if (geometry === null) {
        if (current === undefined) return state;
        const next = { ...state.marks };
        delete next[id];
        return { marks: next };
      }
      if (
        current &&
        current.cx === geometry.cx &&
        current.cy === geometry.cy &&
        current.radius === geometry.radius
      ) {
        return state;
      }
      return { marks: { ...state.marks, [id]: geometry } };
    }),
}));
