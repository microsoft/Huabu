import { useInternalNode, useStore, useViewport } from '@xyflow/react';
import { useRef } from 'react';

import {
  badgeSizeForNode,
  markSizeForStage,
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
   * Canvas-space radius of the collapsed mark circle, or `null` when the node
   * is readable. Zoom-independent (the mark fills the node's shorter side), so
   * edges can clip to it without recomputing on every zoom frame.
   */
  collapsedRadius: number | null;
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
      collapsedRadius: null,
    };
  }

  const screenW = width * zoom;
  const screenH = height * zoom;
  const stage = resolveQuestionStage(prevStage.current, screenW, screenH);
  prevStage.current = stage;

  const left = abs.x * zoom + vpX;
  const top = abs.y * zoom + vpY;
  const size = markSizeForStage(stage, screenW, screenH);
  const badge = badgeSizeForNode(screenW, screenH);

  // Stage 1: hug the node's top-left corner (scales with the card). Stage 2/3:
  // the node centre (the mark stands in for the whole node).
  const point: TakeoverPoint =
    stage === 'readable'
      ? { x: left + badge * 0.3, y: top + badge * 0.05 }
      : { x: left + screenW / 2, y: top + screenH / 2 };

  // Collapsed stages: the mark is a bounded curve (not the footprint), so edges
  // clip to the actual mark circle. Radius in canvas space = screen size / zoom.
  const collapsedRadius = stage === 'readable' ? null : size / (2 * zoom);

  return { stage, size, point, collapsedRadius };
}
