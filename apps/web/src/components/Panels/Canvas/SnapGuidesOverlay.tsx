import React, { useMemo } from 'react';

import { useDragPreviewStore } from '@/store/dragPreviewStore';

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
 * `dragPreviewStore.snapGuides` and is written by `canvasStore`'s
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
  const guides = useDragPreviewStore((s) => s.snapGuides);

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
      {segments.map((seg, i) => (
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
          {seg.equalRects?.map((r, j) => (
            <EqualSpacingTick key={j} rect={r} axis={seg} />
          ))}
        </g>
      ))}
    </svg>
  );
};

/**
 * Small "‖" marker drawn at the midpoint between two equal-spaced
 * rects, indicating that the gap on each side of the dragged source
 * is identical. Mirrors the red double-tick Figma renders on its
 * equal-spacing guides (we use info-tone for visual consistency with
 * the rest of the alignment overlay).
 */
const EqualSpacingTick: React.FC<{
  rect: { x: number; y: number; w: number; h: number };
  axis: ScreenSegment;
}> = ({ rect, axis }) => {
  // The segment is either roughly horizontal (y1 == y2) or vertical
  // (x1 == x2). The tick is drawn perpendicular to the segment at the
  // centre of the rect's projected extent.
  const isVertical = Math.abs(axis.x1 - axis.x2) < 1;
  const cx = isVertical ? axis.x1 : rect.x + rect.w / 2;
  const cy = isVertical ? rect.y + rect.h / 2 : axis.y1;
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

  const equalRects = guide.equalSpacing?.rects.map((r) => {
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
  });

  return {
    x1: start.x - wrapperRect.left,
    y1: start.y - wrapperRect.top,
    x2: end.x - wrapperRect.left,
    y2: end.y - wrapperRect.top,
    equalSpacing: guide.equalSpacing !== undefined,
    equalRects,
  };
}
