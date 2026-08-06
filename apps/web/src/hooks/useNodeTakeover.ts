// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useInternalNode, useStore, useViewport } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';

import {
  badgeSizeForNode,
  clamp01,
  collapseProgress,
  collapsedMarkSize,
  lerp,
  resolveQuestionStage,
  TAKEOVER_GLIDE_MS,
  type QuestionLodStage,
  type TakeoverPoint,
} from '@/config/nodeTakeover';

import type { MarkAnchorRect } from '@/store/nodeCollapseStore';

export interface NodeTakeoverGeometry {
  stage: QuestionLodStage;
  /** Rendered mark diameter (screen px). */
  size: number;
  /** Screen point (px) the mark centre should sit on this frame. */
  point: TakeoverPoint;
  /**
   * Canvas-space centre of the mark this frame, or `null` while the mark is
   * resting at the readable card's corner.
   */
  collapsedCenter: TakeoverPoint | null;
  /**
   * Canvas-space radius of the collapsed mark circle, or `null` while the mark
   * is resting at the readable card's corner.
   */
  collapsedRadius: number | null;
  /**
   * Glide progress `p ∈ [0,1]`: 0 with the mark at the card's corner, 1 with it
   * standing in for the whole node at its centre. Published with the mark so
   * interaction chrome can ease footprint → mark on the same curve.
   */
  glideProgress: number;
  /**
   * The node's canvas-space border box, or `null` while the mark rests at the
   * card's corner. This is the `p = 0` end of every chrome blend, published
   * from here so ports, outlines, and the toolbar all measure the node the way
   * the takeover itself does.
   */
  collapsedFootprint: MarkAnchorRect | null;
}

/**
 * Eases toward 1 while the card is hidden and back to 0 while it is showing,
 * over {@link TAKEOVER_GLIDE_MS}.
 *
 * The mark's POSITION cannot be a function of zoom the way its size is. Edges,
 * ports, and outlines all terminate on the node's own border box, and the card
 * is the only thing that makes that box visible — so the mark has to hang off
 * the card's corner for exactly as long as the card is drawn, and sit at the
 * centre those edges converge on for exactly as long as it is standing in for
 * the node. A zoom-driven glide is out of step with the card on both counts:
 * it strands the mark mid-flight over a card that is still there, and leaves it
 * parked at a corner of nothing once the card has gone.
 */
function useGlideProgress(stage: QuestionLodStage | null): number {
  const target = stage === 'collapsed' ? 1 : 0;
  const [, bumpFrame] = useState(0);
  const liveRef = useRef(0);
  const settledRef = useRef(false);

  // A node has no stage until React Flow has measured it. Adopting the first
  // measured stage outright rather than animating to it keeps a canvas that
  // loads already zoomed out from sweeping every mark — and every edge endpoint
  // that now follows it — in from the card's corner on load.
  if (stage !== null && !settledRef.current) {
    settledRef.current = true;
    liveRef.current = target;
  }

  useEffect(() => {
    if (stage === null || liveRef.current === target) return;
    const from = liveRef.current;
    // Seeded from the first callback rather than `performance.now()`: the two
    // are not guaranteed to share a time origin, and a negative elapsed time
    // sends smoothstep outside its domain, where it diverges instead of
    // saturating. `liveRef` then feeds the next run, so one bad frame compounds
    // and never re-converges — which drove `progress` into the thousands and
    // put the handles, and every edge endpoint measured from them, 10^8 units
    // off the node.
    let startedAt: number | null = null;
    let frame = requestAnimationFrame(function step(now) {
      startedAt ??= now;
      const raw = clamp01((now - startedAt) / TAKEOVER_GLIDE_MS);
      const eased = raw * raw * (3 - 2 * raw);
      liveRef.current = clamp01(from + (target - from) * eased);
      bumpFrame((n) => n + 1);
      if (raw < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [stage, target]);

  return liveRef.current;
}

/**
 * Drives the zoom-LOD takeover geometry for one question node. Self-subscribes
 * to the viewport (zoom + pan) and the node's canvas-space size, resolves the
 * crisp {@link QuestionLodStage} with hysteresis, and returns the mark's screen
 * point + size. It owns geometry + staging only; the mark decides what to draw.
 * Non-takeover nodes never mount it, so they pay nothing.
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
  const screenW = abs ? width * zoom : 0;
  const stage =
    abs && width > 0 && height > 0
      ? resolveQuestionStage(prevStage.current, screenW)
      : null;
  if (stage !== null) prevStage.current = stage;
  const p = useGlideProgress(stage);

  if (stage === null || !abs) {
    return {
      stage: 'readable',
      size: badgeSizeForNode(0, 0),
      point: { x: 0, y: 0 },
      collapsedCenter: null,
      collapsedRadius: null,
      glideProgress: 0,
      collapsedFootprint: null,
    };
  }

  const screenH = height * zoom;

  const left = abs.x * zoom + vpX;
  const top = abs.y * zoom + vpY;

  // SIZE tracks the zoom continuously, so the badge shrinks with the card it is
  // pinned to; POSITION does not (see `useGlideProgress`).
  const t = collapseProgress(screenW);
  const badge = badgeSizeForNode(screenW, screenH);
  const mark = collapsedMarkSize(screenW, screenH);
  const size = lerp(badge, mark, t);

  // Endpoints: the readable badge hugs the node's top-left corner; the collapsed
  // mark sits at the node centre, which is where the node's edges point.
  const cornerX = left + badge * 0.3;
  const cornerY = top + badge * 0.05;
  const centreX = left + screenW / 2;
  const centreY = top + screenH / 2;
  const point: TakeoverPoint = {
    x: lerp(cornerX, centreX, p),
    y: lerp(cornerY, centreY, p),
  };

  // Chrome anchors to the mark only once it has left the corner, and eases back
  // onto the card on the way in, so the glide is symmetric.
  const anchored = p > 0;
  const collapsedRadius = anchored ? size / (2 * zoom) : null;

  // Canvas-space centre of the mark. Built from `abs` + a canvas-space offset
  // rather than by unprojecting `point`: `vp` cancels analytically, but `(a·z +
  // vp) − vp` loses low bits at realistic pan magnitudes, so the round trip
  // made the centre jitter on every pan frame — which `setMark`'s identity
  // check reads as movement and re-renders every outline and port anchored to
  // the mark, during the one gesture React Flow otherwise handles with a CSS
  // transform alone.
  const collapsedCenter = anchored
    ? {
        x: abs.x + lerp((badge * 0.3) / zoom, width / 2, p),
        y: abs.y + lerp((badge * 0.05) / zoom, height / 2, p),
      }
    : null;

  const collapsedFootprint = anchored
    ? { x: abs.x, y: abs.y, width, height }
    : null;

  return {
    stage,
    size,
    point,
    collapsedCenter,
    collapsedRadius,
    glideProgress: p,
    collapsedFootprint,
  };
}
