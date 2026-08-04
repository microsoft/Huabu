import { create } from 'zustand';

/** A rectangle in canvas space. */
export interface MarkAnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

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
  /**
   * Continuous collapse progress `t ∈ [0,1]` for this frame — 0 while the mark
   * still rests at the card's corner, 1 once it is the centred mark.
   *
   * Chrome is PUBLISHED on the discrete stage (which flips near `t ≈ 0.06`)
   * but must be POSITIONED on this, blending footprint → mark. Reading the
   * geometry alone would snap every edge, port, and outline onto a circle
   * still parked at the node's top-left corner the instant the stage flipped.
   */
  progress: number;
  /** The node's own canvas-space border box — the `progress === 0` end of the blend. */
  footprint: MarkAnchorRect;
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

/**
 * Canvas-space bounding square of a collapsed mark.
 *
 * This is the rect interaction chrome should anchor to while a node is
 * collapsed. The node's own footprint still exists and is still selectable,
 * but it has faded to zero opacity — chrome drawn against it reads as a
 * selection box, toolbar, and ports floating in empty canvas next to a small
 * mark they appear to have nothing to do with.
 */
export function collapsedMarkRect(mark: CollapsedMarkGeometry): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const size = mark.radius * 2;
  return {
    x: mark.cx - mark.radius,
    y: mark.cy - mark.radius,
    width: size,
    height: size,
  };
}

/** Eases `from` toward `to` by a clamped collapse progress. */
export function easeToward(from: number, to: number, progress: number): number {
  const t = Math.min(1, Math.max(0, progress));
  return from + (to - from) * t;
}

/**
 * The rect chrome should anchor to mid-takeover: the node's own footprint
 * eased toward {@link collapsedMarkRect} by the mark's {@link
 * CollapsedMarkGeometry.progress}.
 *
 * This is the geometry every consumer wants. The mark's own rect is only
 * correct at `progress === 1`; before that the mark is still gliding in from
 * the corner, so anchoring straight to it drops the chrome inside the card.
 */
export function blendedMarkRect(mark: CollapsedMarkGeometry): MarkAnchorRect {
  const target = collapsedMarkRect(mark);
  const { footprint, progress } = mark;
  return {
    x: easeToward(footprint.x, target.x, progress),
    y: easeToward(footprint.y, target.y, progress),
    width: easeToward(footprint.width, target.width, progress),
    height: easeToward(footprint.height, target.height, progress),
  };
}

/**
 * Where an edge that used to land on `(fromX, fromY)` should land while the
 * node is collapsing — the point on the {@link blendedMarkRect} boundary that
 * lies along the ray from the shape's centre through that original handle.
 *
 * Boundary point, not an interpolated one. Easing the endpoint straight toward
 * the mark's circle drags it through the card's interior, so mid-band the edge
 * ends in open space over the node's text instead of touching anything. Here
 * the shape itself morphs (border box → mark disc, rectangular → elliptical
 * projection by the same `progress`), so the endpoint is always ON an edge of
 * whatever is currently drawn: exactly the handle at `progress === 0`, exactly
 * the mark's circle at 1.
 */
export function markBoundaryPoint(
  mark: CollapsedMarkGeometry,
  fromX: number,
  fromY: number,
): { x: number; y: number } {
  const rect = blendedMarkRect(mark);
  const halfW = rect.width / 2;
  const halfH = rect.height / 2;
  const cx = rect.x + halfW;
  const cy = rect.y + halfH;
  if (halfW <= 0 || halfH <= 0) return { x: cx, y: cy };
  const dx = fromX - cx;
  const dy = fromY - cy;
  const nx = Math.abs(dx) / halfW;
  const ny = Math.abs(dy) / halfH;
  const norm = Math.hypot(nx, ny);
  if (norm === 0) return { x: cx, y: cy };
  // `1 / max` hits the rectangle, `1 / hypot` the inscribed ellipse.
  const scale = easeToward(1 / Math.max(nx, ny), 1 / norm, mark.progress);
  return { x: cx + dx * scale, y: cy + dy * scale };
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
        current.radius === geometry.radius &&
        current.progress === geometry.progress &&
        current.footprint.x === geometry.footprint.x &&
        current.footprint.y === geometry.footprint.y &&
        current.footprint.width === geometry.footprint.width &&
        current.footprint.height === geometry.footprint.height
      ) {
        return state;
      }
      return { marks: { ...state.marks, [id]: geometry } };
    }),
}));
