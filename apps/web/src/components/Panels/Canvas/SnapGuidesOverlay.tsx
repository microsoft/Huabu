// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import React, { useMemo } from 'react';

import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import type { Guide } from '@/handler/snap/types';
import type { ReactFlowInstance } from '@xyflow/react';

type Props = {
  rfInstance: ReactFlowInstance | null;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
};

type ScreenSegment = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** True when this guide represents an equal-spacing match. */
  equalSpacing: boolean;
  /** Optional rectangles to draw "= =" annotation segments between. */
  equalRects?: { x: number; y: number; w: number; h: number }[];
};

/**
 * Render the active smart-snap alignment guides as an SVG overlay
 * sitting on top of the React Flow canvas. The guide list lives on
 * `gesturePreviewStore.snapGuides` and is written by `canvasStore`'s
 * snap pipeline once per drag tick.
 *
 * Guide coordinates are in absolute flow-space. We convert each end
 * to wrapper-relative screen pixels via `rfInstance.flowToScreenPosition`
 * on every render — cheap (≤ 8 guides per frame, hard-capped by
 * `SNAP_MAX_GUIDES_PER_FRAME`) and avoids a separate cache that
 * could go stale on pan/zoom.
 */
export const SnapGuidesOverlay: React.FC<Props> = ({
  rfInstance,
  wrapperRef,
}) => {
  const guides = useGesturePreviewStore((s) => s.snapGuides);

  const segments = useMemo<ScreenSegment[]>(() => {
    if (!rfInstance || !wrapperRef.current || guides.length === 0) return [];
    const wrapperRect = wrapperRef.current.getBoundingClientRect();

    return guides.map((g) => guideToSegment(g, rfInstance, wrapperRect));
  }, [guides, rfInstance, wrapperRef]);

  if (segments.length === 0) return null;

  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-40 h-full w-full"
    >
      {segments.map((seg, i) => {
        const eqRects = seg.equalRects;
        return (
          <g key={i}>
            <line
              x1={seg.x1}
              y1={seg.y1}
              x2={seg.x2}
              y2={seg.y2}
              stroke="var(--color-info)"
              strokeWidth={1}
              strokeDasharray={seg.equalSpacing ? '4 3' : undefined}
            />
            {eqRects?.slice(0, -1).map((a, j) => (
              <EqualSpacingTick key={j} a={a} b={eqRects[j + 1]} axis={seg} />
            ))}
          </g>
        );
      })}
    </svg>
  );
};

/**
 * Small "‖" marker drawn at the midpoint of the gap between two
 * adjacent equal-spaced rects, indicating that the gap on each side
 * of the dragged source is identical. For a guide spanning N rects
 * (always 3 in practice — the source plus its two neighbours), the
 * overlay renders N-1 ticks, one per gap. Mirrors the double-tick
 * common design tools render on their equal-spacing guides (we use info-tone for
 * visual consistency with the rest of the alignment overlay).
 */
const EqualSpacingTick: React.FC<{
  /** Leading rect along the spacing axis. */
  a: { x: number; y: number; w: number; h: number };
  /** Trailing rect along the spacing axis (immediately after `a`). */
  b: { x: number; y: number; w: number; h: number };
  axis: ScreenSegment;
}> = ({ a, b, axis }) => {
  // The segment is either roughly horizontal (y1 == y2) or vertical
  // (x1 == x2). The tick is drawn perpendicular to the segment at
  // the midpoint of the empty gap between `a`'s trailing edge and
  // `b`'s leading edge along the spacing axis — so it visually sits
  // *between* the two rects, not on top of either.
  const isVertical = Math.abs(axis.x1 - axis.x2) < 1;
  const cx = isVertical ? axis.x1 : (a.x + a.w + b.x) / 2;
  const cy = isVertical ? (a.y + a.h + b.y) / 2 : axis.y1;
  const len = 6;
  if (isVertical) {
    return (
      <line
        x1={cx - len}
        y1={cy}
        x2={cx + len}
        y2={cy}
        stroke="var(--color-info)"
        strokeWidth={1.5}
      />
    );
  }
  return (
    <line
      x1={cx}
      y1={cy - len}
      x2={cx}
      y2={cy + len}
      stroke="var(--color-info)"
      strokeWidth={1.5}
    />
  );
};

/**
 * Convert a flow-space guide into a wrapper-relative screen segment
 * the SVG layer can render directly. Equal-spacing guides additionally
 * project their participant rects so the tick markers can be drawn.
 */
function guideToSegment(
  guide: Guide,
  rfInstance: ReactFlowInstance,
  wrapperRect: DOMRect,
): ScreenSegment {
  const isXAxis = guide.axis === 'x';
  // For an x-axis (vertical) guide, the line runs at constant X and
  // spans [from, to] on Y. For a y-axis (horizontal) guide, vice versa.
  const startFlow = isXAxis
    ? { x: guide.value, y: guide.from }
    : { x: guide.from, y: guide.value };
  const endFlow = isXAxis
    ? { x: guide.value, y: guide.to }
    : { x: guide.to, y: guide.value };

  const start = rfInstance.flowToScreenPosition(startFlow);
  const end = rfInstance.flowToScreenPosition(endFlow);

  const isEqualSpacing = guide.kind === 'equal-spacing';
  const equalRects = isEqualSpacing
    ? guide.rects.map((r) => {
        const tl = rfInstance.flowToScreenPosition({ x: r.x, y: r.y });
        const br = rfInstance.flowToScreenPosition({
          x: r.x + r.w,
          y: r.y + r.h,
        });
        return {
          x: tl.x - wrapperRect.left,
          y: tl.y - wrapperRect.top,
          w: br.x - tl.x,
          h: br.y - tl.y,
        };
      })
    : undefined;

  return {
    x1: start.x - wrapperRect.left,
    y1: start.y - wrapperRect.top,
    x2: end.x - wrapperRect.left,
    y2: end.y - wrapperRect.top,
    equalSpacing: isEqualSpacing,
    equalRects,
  };
}
