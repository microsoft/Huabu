import { useInternalNode, useStore, useViewport } from '@xyflow/react';
import { useRef } from 'react';

import {
  badgeSizeForZoom,
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
      size: badgeSizeForZoom(zoom),
      point: { x: 0, y: 0 },
    };
  }

  const screenW = width * zoom;
  const screenH = height * zoom;
  const stage = resolveQuestionStage(prevStage.current, screenW, screenH);
  prevStage.current = stage;

  const left = abs.x * zoom + vpX;
  const top = abs.y * zoom + vpY;
  const size = markSizeForStage(stage, zoom, screenW, screenH);
  const badge = badgeSizeForZoom(zoom);

  // Stage 1: hug the node's top-left corner (scales with the card). Stage 2/3:
  // the node centre (the mark stands in for the whole node).
  const point: TakeoverPoint =
    stage === 'readable'
      ? { x: left + badge * 0.3, y: top + badge * 0.05 }
      : { x: left + screenW / 2, y: top + screenH / 2 };

  return { stage, size, point };
}
