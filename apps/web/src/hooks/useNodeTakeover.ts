// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useInternalNode, useStore, useViewport } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';

import {
  clamp01,
  QUESTION_TAKEOVER_AVATAR_RATIO,
  QUESTION_TAKEOVER_CARD_RATIO,
  resolveQuestionStage,
  TAKEOVER_GLIDE_MS,
  type QuestionLodStage,
  type TakeoverPoint,
} from '@/config/nodeTakeover';
import { QUESTION_NODE_DEFAULT_FONT_SIZE } from '@/utils/node/nodeFontConfig';

import type { MarkAnchorRect } from '@/store/nodeCollapseStore';

export interface NodeTakeoverGeometry {
  stage: QuestionLodStage;
  /** Rendered mark diameter (screen px). */
  size: number;
  /** Screen point (px) the mark centre should sit on this frame. */
  point: TakeoverPoint;
  /**
   * Canvas-space centre of the visible mark, or null at settled readable.
   */
  collapsedCenter: TakeoverPoint | null;
  /**
   * Canvas-space radius enclosing the visible ring/bubble and satellites.
   */
  collapsedRadius: number | null;
  /**
   * Blend progress: 0 is the card, 1 is its centered stand-in. Chrome follows
   * the same fade; the mark itself stays centered throughout the handoff.
   */
  glideProgress: number;
  /**
   * The node's canvas-space border box, or null at settled readable.
   * This is the `p = 0` end of every chrome blend, published
   * from here so ports, outlines, and the toolbar all measure the node the way
   * the takeover itself does.
   */
  collapsedFootprint: MarkAnchorRect | null;
}

/**
 * Eases toward 1 while the card is hidden and back to 0 while it is showing,
 * over {@link TAKEOVER_GLIDE_MS}.
 *
 * Retain the existing reversible fade and chrome blend. Position and authored
 * geometry no longer glide or interpolate with viewport zoom.
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
export function useNodeTakeover(
  nodeId: string,
  boundsRatio = QUESTION_TAKEOVER_AVATAR_RATIO,
  fontSize = QUESTION_NODE_DEFAULT_FONT_SIZE,
  forceCollapsed = false,
): NodeTakeoverGeometry {
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
  const fontStage =
    abs && width > 0 && height > 0
      ? resolveQuestionStage(prevStage.current, zoom, fontSize)
      : null;
  if (fontStage !== null) prevStage.current = fontStage;
  const stage = fontStage !== null && forceCollapsed ? 'collapsed' : fontStage;
  const p = useGlideProgress(stage);

  if (stage === null || !abs) {
    return {
      stage: 'readable',
      size: 0,
      point: { x: 0, y: 0 },
      collapsedCenter: null,
      collapsedRadius: null,
      glideProgress: 0,
      collapsedFootprint: null,
    };
  }

  const authoredSize =
    (Math.min(width, height) * QUESTION_TAKEOVER_CARD_RATIO) /
    QUESTION_TAKEOVER_AVATAR_RATIO;
  const size = authoredSize * zoom;
  // Presentation never changes the persisted footprint. Center the visible
  // mark there, and derive canvas anchors directly so pure panning is stable.
  const center = { x: abs.x + width / 2, y: abs.y + height / 2 };
  const point: TakeoverPoint = {
    x: center.x * zoom + vpX,
    y: center.y * zoom + vpY,
  };

  // Publish only while the mark participates in the reversible fade.
  const anchored = p > 0;
  const collapsedRadius = anchored ? (authoredSize * boundsRatio) / 2 : null;

  // Canvas-space centre of the mark. Built from `abs` + a canvas-space offset
  // rather than by unprojecting `point`: `vp` cancels analytically, but `(a·z +
  // vp) − vp` loses low bits at realistic pan magnitudes, so the round trip
  // made the centre jitter on every pan frame — which `setMark`'s identity
  // check reads as movement and re-renders every outline and port anchored to
  // the mark, during the one gesture React Flow otherwise handles with a CSS
  // transform alone.
  const collapsedCenter = anchored ? center : null;

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
