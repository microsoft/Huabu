// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

/** A rectangle in canvas space. */
export interface MarkAnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Canvas-space geometry of a node's zoom-LOD collapsed mark — where the mark
 * currently sits and how big it is, so interaction chrome can follow it while
 * the node's card fades away underneath.
 *
 * Edges are deliberately NOT a consumer: they stay on React Flow's handle
 * points, and the mark glides to the node's centre to meet them.
 */
export interface CollapsedMarkGeometry {
  /** Canvas-space centre of the mark this frame. */
  cx: number;
  cy: number;
  /** Canvas-space clip radius of the mark this frame. */
  radius: number;
  /**
   * Glide progress `p ∈ [0,1]` — 0 with the mark at the card's corner, 1 with
   * it centred in place of the node. Chrome must be POSITIONED on this, easing
   * footprint → mark; adopting the mark's own geometry outright would drop the
   * chrome onto a circle still parked at the node's top-left corner.
   */
  progress: number;
  /** The node's own canvas-space border box — the `progress === 0` end of the blend. */
  footprint: MarkAnchorRect;
}

interface NodeCollapseState {
  /**
   * Per-node collapsed-mark geometry, keyed by node id. Absent means the node
   * is not collapsed and chrome should use its normal footprint.
   *
   * Published by {@link NodeTakeoverLayer} and read by the selection outline,
   * floating toolbar, and connect ports, so they frame the visible mark
   * instead of the (now-hidden) card rectangle it replaced.
   */
  marks: Record<string, CollapsedMarkGeometry>;
  setMark: (id: string, geometry: CollapsedMarkGeometry | null) => void;
}

/**
 * Canvas-space bounding square of a fully collapsed mark — the `progress === 1`
 * end of {@link blendedMarkRect}, which is the only thing consumers should read.
 */
function collapsedMarkRect(mark: CollapsedMarkGeometry): MarkAnchorRect {
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
 * The rect chrome should anchor to mid-takeover: the node's own footprint eased
 * toward the mark's bounding square by the mark's {@link
 * CollapsedMarkGeometry.progress}.
 *
 * The node's own footprint still exists and is still selectable while collapsed,
 * but it has faded to zero opacity — chrome drawn against it reads as a
 * selection box, toolbar, and ports floating in empty canvas next to a small
 * mark they appear to have nothing to do with. The mark's own rect is only
 * correct at `progress === 1` though; before that the mark is still gliding in
 * from the corner, so anchoring straight to it drops the chrome inside the card.
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
