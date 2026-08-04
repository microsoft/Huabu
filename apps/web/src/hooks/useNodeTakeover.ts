import { useInternalNode, useStore, useViewport } from '@xyflow/react';
import { useRef } from 'react';

import {
  badgeSizeForNode,
  collapseProgress,
  collapsedMarkSize,
  lerp,
  resolveQuestionStage,
  type QuestionLodStage,
  type TakeoverPoint,
} from '@/config/nodeTakeover';

export interface NodeTakeoverGeometry {
  stage: QuestionLodStage;
  /** Rendered mark diameter (screen px). */
  size: number;
  /** Screen point (px) the mark centre should sit on this frame. */
  point: TakeoverPoint;
  /**
   * Canvas-space centre of the mark this frame, or `null` when the node is
   * readable. Derived from the interpolated screen point so edges clip to where
   * the mark ACTUALLY is during the corner → centre glide.
   */
  collapsedCenter: TakeoverPoint | null;
  /**
   * Canvas-space radius of the collapsed mark circle, or `null` when the node
   * is readable. Zoom-independent (the mark fills the node's shorter side), so
   * edges can clip to it without recomputing on every zoom frame.
   */
  collapsedRadius: number | null;
  /**
   * Continuous collapse progress `t ∈ [0,1]` this frame. Published with the
   * mark so chrome can ease footprint → mark instead of jumping to a circle
   * still parked at the card's corner when the discrete stage flips.
   */
  collapseT: number;
}

/**
 * Drives the discrete zoom-LOD staging for one question node. Self-subscribes
 * to the viewport (zoom + pan) and the node's canvas-space size, resolves the
 * crisp {@link QuestionLodStage} with hysteresis, and returns the mark's target
 * screen point + size for that stage. It owns geometry + staging only; the mark
 * decides what to draw, and `NodeTakeoverLayer` animates the transition between
 * stages. Non-takeover nodes never mount it, so they pay nothing.
 */
export function useNodeTakeover(nodeId: string): NodeTakeoverGeometry {
  const { zoom, x: vpX, y: vpY } = useViewport();
  const internalNode = useInternalNode(nodeId);
  const width = useStore((s) => {
    const node = s.nodeLookup.get(nodeId);
    return (node?.style?.width as number) || node?.measured?.width || 0;
  });
  const height = useStore((s) => {
    const node = s.nodeLookup.get(nodeId);
    return (node?.style?.height as number) || node?.measured?.height || 0;
  });

  const prevStage = useRef<QuestionLodStage>('readable');
  const abs = internalNode?.internals.positionAbsolute;

  if (!abs || width <= 0 || height <= 0) {
    prevStage.current = 'readable';
    return {
      stage: 'readable',
      size: badgeSizeForNode(0, 0),
      point: { x: 0, y: 0 },
      collapsedCenter: null,
      collapsedRadius: null,
      collapseT: 0,
    };
  }

  const screenW = width * zoom;
  const screenH = height * zoom;
  const stage = resolveQuestionStage(prevStage.current, screenW);
  prevStage.current = stage;

  const left = abs.x * zoom + vpX;
  const top = abs.y * zoom + vpY;

  // Continuous collapse progress (0 = readable card + corner badge, 1 = centred
  // mark). SIZE and POSITION are interpolated by it every frame, so the badge
  // tracks the zoom smoothly instead of snapping + animating at a threshold.
  const t = collapseProgress(screenW);
  const badge = badgeSizeForNode(screenW, screenH);
  const mark = collapsedMarkSize(screenW, screenH);
  const size = lerp(badge, mark, t);

  // Endpoints: the readable badge hugs the node's top-left corner; the collapsed
  // mark sits at the node centre. Lerp between them so the mark glides corner →
  // centre as the node shrinks.
  const cornerX = left + badge * 0.3;
  const cornerY = top + badge * 0.05;
  const centreX = left + screenW / 2;
  const centreY = top + screenH / 2;
  const point: TakeoverPoint = {
    x: lerp(cornerX, centreX, t),
    y: lerp(cornerY, centreY, t),
  };

  // Collapsed: the mark is a bounded curve (not the footprint), so edges clip
  // to the actual mark circle. Radius in canvas space = screen size / zoom.
  const collapsedRadius = stage === 'readable' ? null : size / (2 * zoom);

  // Live canvas-space centre of the mark, so edges clip to where the mark
  // ACTUALLY is during the corner → centre glide, not to a phantom circle
  // pinned at the node centre. Built from `abs` + a canvas-space offset rather
  // than by unprojecting `point`: `vp` cancels analytically, but `(a·z + vp) −
  // vp` loses low bits at realistic pan magnitudes, so the round trip made the
  // centre jitter on every pan frame — which `setMark`'s identity check reads
  // as movement and re-renders every edge and outline anchored to the mark,
  // during the one gesture React Flow otherwise handles with a CSS transform
  // alone.
  const collapsedCenter =
    stage === 'readable'
      ? null
      : {
          x: abs.x + lerp((badge * 0.3) / zoom, width / 2, t),
          y: abs.y + lerp((badge * 0.05) / zoom, height / 2, t),
        };

  return { stage, size, point, collapsedCenter, collapsedRadius, collapseT: t };
}
